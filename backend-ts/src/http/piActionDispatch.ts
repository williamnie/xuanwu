import type { RunnerDatabase } from "../db/database.ts";
import { getAgentSession, upsertAgentSession } from "../db/repositories/agentSessions.ts";
import { enqueueIssue } from "../db/repositories/issueActions.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { createIssueComment } from "../db/repositories/issueEvents.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { applyIssueStateRepair } from "../pi/issueStateManager.ts";
import { createAgentWorkflowProposal, type AgentWorkflowInput } from "../pi/agentOrchestration.ts";
import { createIssueEnqueueCron } from "../pi/runnerIssueScheduleActions.ts";
import type { PiAction } from "../db/repositories/pi.ts";
import { getProject, type Project } from "../db/repositories/projects.ts";
import { startProjectLoop } from "../runner/projectLoopManager.ts";
import type { EventBus } from "../events/bus.ts";
import { isExecutorProviderId, type ExecutorProvider, type ExecutorProviderId } from "../providers/types.ts";
import { dispatchSupervisorPiAction } from "./piSupervisorActionDispatch.ts";

export type PiActionDispatchContext = {
  bus?: Pick<EventBus, "publish">;
  database: RunnerDatabase;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};

export async function dispatchPiAction(
  context: PiActionDispatchContext,
  action: PiAction
): Promise<unknown> {
  const payload = parsePayload(action);
  switch (action.action_type) {
    case "issue.create":
      return createIssue(context.database, payload);
    case "issue.enqueue":
      return enqueueIssueAndStartAutoRun(context, positivePayloadID(payload, "issue_id"));
    case "issue.schedule_enqueue":
      return createIssueEnqueueCron(context.database, payload);
    case "issue.comment":
      return createIssueComment(context.database, positivePayloadID(payload, "issue_id"), payload);
    case "issue.state_repair":
      return applyIssueStateRepair(context.database, payload);
    case "agent.executor_assign":
      return updateIssue(context.database, positivePayloadID(payload, "issue_id"), objectPayload(payload.patch));
    case "agent.workflow_request":
      return createWorkflowIssue(context, action, payload);
    case "needs_user.escalate":
      return createIssueComment(context.database, positivePayloadID(payload, "issue_id"), {
        author: "agent",
        body: cleanString(payload.body) || cleanString(payload.message)
      });
    case "issue.retry":
    case "issue.retry_after":
    case "issue.supervisor_decision":
    case "session.resume_followup":
      return await dispatchSupervisorPiAction(context, action, payload);
    case "session.steer":
      return await steerSession(context, payload);
    default:
      throw new Error(`unsupported PI action type: ${action.action_type}`);
  }
}

function createWorkflowIssue(
  context: PiActionDispatchContext,
  action: PiAction,
  payload: Record<string, unknown>
): unknown {
  const issue = createIssue(context.database, workflowIssuePayload(context.database, action, payload));
  if (issue.status === "todo") startAutoRunProjectLoop(context, issue.project_id);
  return issue;
}

function enqueueIssueAndStartAutoRun(context: PiActionDispatchContext, issueID: number): unknown {
  const issue = enqueueIssue(context.database, issueID);
  startAutoRunProjectLoop(context, issue.project_id);
  return issue;
}

function workflowIssuePayload(
  db: RunnerDatabase,
  action: PiAction,
  payload: Record<string, unknown>
): Record<string, unknown> {
  const base = hasMaterializedWorkflowPayload(payload)
    ? payload
    : createAgentWorkflowProposal(db, workflowProject(db, action, payload), workflowInput(action, payload)).payload;
  return shouldQueueWorkflow(base) ? { ...base, status: "todo" } : base;
}

function hasMaterializedWorkflowPayload(payload: Record<string, unknown>): boolean {
  return cleanString(payload.project_id) !== "" && cleanString(payload.title) !== "" &&
    cleanString(payload.description) !== "";
}

function workflowProject(db: RunnerDatabase, action: PiAction, payload: Record<string, unknown>): Project | undefined {
  const projectID = cleanString(payload.project_id) || action.project_id;
  return projectID === "" ? undefined : getProject(db, projectID) ?? undefined;
}

function workflowInput(action: PiAction, payload: Record<string, unknown>): AgentWorkflowInput {
  const target = positiveInputID(payload.target_issue_id) || positiveInputID(payload.issue_id) || action.issue_id || undefined;
  return {
    agent_profile_id: cleanString(payload.agent_profile_id),
    goal_id: cleanString(payload.goal_id),
    instructions: cleanString(payload.instructions),
    project_id: cleanString(payload.project_id) || action.project_id,
    rationale: cleanString(payload.rationale) || action.rationale,
    recommended_skill_intents: stringList(payload.recommended_skill_intents),
    report_type: cleanString(payload.report_type),
    required_skill_intents: stringList(payload.required_skill_intents),
    role: cleanString(payload.role ?? payload.agent_role),
    target_issue_id: target,
    title: cleanString(payload.title),
    verification_plan: cleanString(payload.verification_plan)
  };
}

function shouldQueueWorkflow(payload: Record<string, unknown>): boolean {
  const role = workflowRole(payload);
  return role === "verifier" || role === "reviewer";
}

function workflowRole(payload: Record<string, unknown>): string {
  return cleanString(payload.role ?? payload.agent_role) || cleanString(workflowSnapshot(payload).agent_role);
}

function workflowSnapshot(payload: Record<string, unknown>): Record<string, unknown> {
  try {
    const parsed = JSON.parse(cleanString(payload.workflow_snapshot_json) || "{}") as unknown;
    return objectPayload(parsed);
  } catch {
    return {};
  }
}

function startAutoRunProjectLoop(context: PiActionDispatchContext, projectID: string): void {
  const project = getProject(context.database, projectID);
  const providerID = project?.provider ?? "";
  if (!project || project.auto_run !== 1 || !isExecutorProviderId(providerID)) return;
  if (!context.providers?.[providerID]?.capabilities.includes("issue_execution")) return;
  startProjectLoop({ bus: context.bus, database: context.database, providers: context.providers }, project.id);
}

function parsePayload(action: PiAction): Record<string, unknown> {
  try {
    const value = JSON.parse(action.payload_json || "{}") as unknown;
    return objectPayload(value);
  } catch {
    throw new Error("PI action payload_json is invalid");
  }
}

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function positivePayloadID(payload: Record<string, unknown>, key: string): number {
  const id = payload[key];
  if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return id;
  throw new Error(`${key} is required`);
}

function positiveInputID(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  const parsed = Number.parseInt(cleanString(value), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(cleanString).filter(Boolean);
  const text = cleanString(value);
  if (text === "") return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed.map(cleanString).filter(Boolean);
  } catch {}
  return text.split(/\n|,/).map(cleanString).filter(Boolean);
}

async function steerSession(
  context: PiActionDispatchContext,
  payload: Record<string, unknown>
): Promise<unknown> {
  const providerID = sessionProviderID(payload);
  const sessionID = sessionProviderSessionID(payload);
  const prompt = cleanString(payload.prompt);
  if (prompt === "") throw new Error("prompt is required");
  const provider = context.providers?.[providerID];
  if (!provider?.sendSessionMessage) throw new Error(`provider "${providerID}" 不支持 capability "resume_session"`);
  const result = await provider.sendSessionMessage({
    mode: "steer",
    prompt,
    sessionId: sessionID,
    turnId: latestSessionTurnID(context.database, providerID, sessionID, payload)
  });
  persistSteeredSession(context.database, providerID, sessionID, result.turn_id);
  return result;
}

function sessionProviderID(payload: Record<string, unknown>): ExecutorProviderId {
  const sessionKey = cleanString(payload.session_key);
  const provider = cleanString(payload.provider) || sessionKey.split(":")[0] || "codex";
  if (isExecutorProviderId(provider)) return provider;
  throw new Error("session provider 暂不支持");
}

function sessionProviderSessionID(payload: Record<string, unknown>): string {
  const id = cleanString(payload.provider_session_id) || sessionIDFromKey(cleanString(payload.session_key));
  if (id === "") throw new Error("session id 不能为空");
  return id;
}

function latestSessionTurnID(
  db: RunnerDatabase,
  providerID: ExecutorProviderId,
  sessionID: string,
  payload: Record<string, unknown>
): string {
  const payloadTurnID = cleanString(payload.provider_turn_id) || cleanString(payload.turn_id);
  if (payloadTurnID !== "") return payloadTurnID;
  const session = getAgentSession(db, `${providerID}:${sessionID}`);
  return rawRefTurnID(session?.raw_ref);
}

function persistSteeredSession(
  db: RunnerDatabase,
  provider: ExecutorProviderId,
  sessionID: string,
  turnID: string
): void {
  if (turnID === "") return;
  upsertAgentSession(db, {
    provider,
    provider_session_id: sessionID,
    raw_ref: { provider_turn_id: turnID },
    status: "running"
  });
}

function sessionIDFromKey(sessionKey: string): string {
  const separator = sessionKey.indexOf(":");
  return separator < 0 ? sessionKey : sessionKey.slice(separator + 1).trim();
}

function rawRefTurnID(rawRef: string | undefined): string {
  if (!rawRef) return "";
  try {
    const parsed = JSON.parse(rawRef) as Record<string, unknown>;
    return cleanString(parsed.provider_turn_id);
  } catch {
    return "";
  }
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
