import type { RunnerDatabase } from "../../db/database.ts";
import { getAgentSession, upsertAgentSession } from "../../db/repositories/agentSessions.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { updateIssue } from "../../db/repositories/issueUpdate.ts";
import { createAgentWorkflowProposal, type AgentWorkflowInput } from "../../pi/runtime/agentOrchestration.ts";
import type { PiAction } from "../../db/repositories/pi.ts";
import { getProject, type Project } from "../../db/repositories/projects.ts";
import { isExecutorProviderId, type ExecutorProviderId } from "../../providers/types.ts";
import { requestIssuePiAcceptance } from "../../runner/piAcceptanceRequest.ts";
import { cleanString, objectValue } from "../../util/values.ts";
import type { PiActionDispatchContext } from "./piActionDispatch.model.ts";
import { positivePayloadID, startAutoRunProjectLoop, positiveInputID } from "./piActionDispatch.replyDraftPayload.ts";

export async function requestIssueAcceptanceAction(
  context: PiActionDispatchContext,
  action: PiAction,
  payload: Record<string, unknown>
): Promise<unknown> {
  const issueID = positivePayloadID(payload, "issue_id");
  const issue = requestIssuePiAcceptance(context.database, issueID, {
    reason: cleanString(payload.rationale),
    source: "pi-action-completion-reconciliation"
  });
  return {
    issue: {
      id: issue.id,
      project_id: issue.project_id,
      status: issue.status,
      title: issue.title
    },
    target_status: issue.status,
    transition_path: []
  };
}

export async function updateExecutorIssue(
  db: RunnerDatabase,
  action: PiAction,
  payload: Record<string, unknown>
): Promise<unknown> {
  const issueID = positivePayloadID(payload, "issue_id");
  const patch = objectValue(payload.patch);
  if (cleanString(patch.status) !== "done") return updateIssue(db, issueID, patch);
  return requestIssuePiAcceptance(db, issueID, {
    reason: cleanString(patch.reason) || `PI action ${action.id} requested done`,
    source: "pi-agent-executor-assign"
  });
}

export function createWorkflowIssue(
  context: PiActionDispatchContext,
  action: PiAction,
  payload: Record<string, unknown>
): unknown {
  const issue = createIssue(context.database, workflowIssuePayload(context.database, action, payload));
  if (issue.status === "todo") startAutoRunProjectLoop(context, issue.project_id);
  return issue;
}

export function workflowIssuePayload(
  db: RunnerDatabase,
  action: PiAction,
  payload: Record<string, unknown>
): Record<string, unknown> {
  const base = hasMaterializedWorkflowPayload(payload)
    ? payload
    : createAgentWorkflowProposal(db, workflowProject(db, action, payload), workflowInput(action, payload)).payload;
  return shouldQueueWorkflow(base) ? { ...base, status: "todo" } : base;
}

export function hasMaterializedWorkflowPayload(payload: Record<string, unknown>): boolean {
  return cleanString(payload.project_id) !== "" && cleanString(payload.title) !== "" &&
    cleanString(payload.description) !== "";
}

export function workflowProject(db: RunnerDatabase, action: PiAction, payload: Record<string, unknown>): Project | undefined {
  const projectID = cleanString(payload.project_id) || action.project_id;
  return projectID === "" ? undefined : getProject(db, projectID) ?? undefined;
}

export function workflowInput(action: PiAction, payload: Record<string, unknown>): AgentWorkflowInput {
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

export function shouldQueueWorkflow(payload: Record<string, unknown>): boolean {
  const role = workflowRole(payload);
  return role === "reviewer";
}

export function workflowRole(payload: Record<string, unknown>): string {
  return cleanString(payload.role ?? payload.agent_role) || cleanString(workflowSnapshot(payload).agent_role);
}

export function workflowSnapshot(payload: Record<string, unknown>): Record<string, unknown> {
  try {
    const parsed = JSON.parse(cleanString(payload.workflow_snapshot_json) || "{}") as unknown;
    return objectValue(parsed);
  } catch {
    return {};
  }
}

export function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(cleanString).filter(Boolean);
  const text = cleanString(value);
  if (text === "") return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed.map(cleanString).filter(Boolean);
  } catch {}
  return text.split(/\n|,/).map(cleanString).filter(Boolean);
}

export function sessionProviderID(payload: Record<string, unknown>): ExecutorProviderId {
  const sessionKey = cleanString(payload.session_key);
  const provider = cleanString(payload.provider) || sessionKey.split(":")[0] || "codex";
  if (isExecutorProviderId(provider)) return provider;
  throw new Error("session provider 暂不支持");
}

export function sessionProviderSessionID(payload: Record<string, unknown>): string {
  const id = cleanString(payload.provider_session_id) || sessionIDFromKey(cleanString(payload.session_key));
  if (id === "") throw new Error("session id 不能为空");
  return id;
}

export function latestSessionTurnID(
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

export function persistSteeredSession(
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

export function sessionIDFromKey(sessionKey: string): string {
  const separator = sessionKey.indexOf(":");
  return separator < 0 ? sessionKey : sessionKey.slice(separator + 1).trim();
}

export function rawRefTurnID(rawRef: string | undefined): string {
  if (!rawRef) return "";
  try {
    const parsed = JSON.parse(rawRef) as Record<string, unknown>;
    return cleanString(parsed.provider_turn_id);
  } catch {
    return "";
  }
}
