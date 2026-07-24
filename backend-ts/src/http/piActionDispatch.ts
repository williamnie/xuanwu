import type { RunnerDatabase } from "../db/database.ts";
import { getAgentSession, upsertAgentSession } from "../db/repositories/agentSessions.ts";
import { enqueueIssue } from "../db/repositories/issueActions.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { createIssueComment } from "../db/repositories/issueEvents.ts";
import { getIssue, listIssues } from "../db/repositories/issues.ts";
import { approveImReplyDraft, createImReplyDraft } from "../db/repositories/imReplyOutbox.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { applyIssueStateRepair } from "../pi/issueStateManager.ts";
import { createAgentWorkflowProposal, type AgentWorkflowInput } from "../pi/agentOrchestration.ts";
import { createIssueEnqueueCron } from "../pi/runnerIssueScheduleActions.ts";
import {
  askUserActionResult,
  createMemoryFromAction,
  createReminderFromAction,
  createWatchThreadFromAction,
  noActionResult
} from "../pi/nonIssueProposalActions.ts";
import type { PiAction } from "../db/repositories/pi.ts";
import { getProject, type Project } from "../db/repositories/projects.ts";
import {
  startProjectLoop as defaultStartProjectLoop,
  type ProjectLoopRuntime,
  type ProjectLoopStartOptions
} from "../runner/projectLoopManager.ts";
import type { EventBus } from "../events/bus.ts";
import { isExecutorProviderId, type ExecutorProvider, type ExecutorProviderId } from "../providers/types.ts";
import { dispatchSupervisorPiAction } from "./piSupervisorActionDispatch.ts";
import { isRunnerChatSource } from "../pi/runnerChatAuthorization.ts";
import { dispatchNeedsUserEscalation } from "../notifications/piNeedsUserAction.ts";
import {
  cancelIssueCompletionWatchAction,
  createIssueCompletionWatchAction,
  type IssueCompletionWatchCancelInput,
  type IssueCompletionWatchCreateInput
} from "../pi/issueCompletionWatchActions.ts";
import {
  completeIssueFromRuntimeEvidence,
  reconcileIssueCompletionFromRuntimeEvidence
} from "../domain/evidence/completionGate.ts";

export type ProjectLoopStarter = (
  runtime: ProjectLoopRuntime,
  projectID: string,
  options?: ProjectLoopStartOptions
) => void;

export type PiActionDispatchContext = {
  bus?: Pick<EventBus, "publish">;
  database: RunnerDatabase;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  startProjectLoop?: ProjectLoopStarter;
};

export async function dispatchPiAction(
  context: PiActionDispatchContext,
  action: PiAction
): Promise<unknown> {
  const payload = parsePayload(action);
  switch (action.action_type) {
    case "issue.create":
      return createIssue(context.database, issueCreatePayload(payload));
    case "issue.enqueue":
      return enqueueIssueAndStartAutoRun(context, action, positivePayloadID(payload, "issue_id"));
    case "issue.status_lookup":
      return lookupIssueStatus(context.database, payload);
    case "message.reply_draft":
      return createImReplyDraft(context.database, replyDraftPayload(payload, action));
    case "message.reply_send":
      return approveImReplyDraft(context.database, createImReplyDraft(
        context.database,
        replyDraftPayload(payload, action)
      ).id);
    case "issue.schedule_enqueue":
      return createIssueEnqueueCron(context.database, payload);
    case "ask_user":
      return askUserActionResult(action, payload);
    case "watch_thread":
      return createWatchThreadFromAction(context.database, action, payload);
    case "reminder.create":
      return createReminderFromAction(context.database, action, payload);
    case "memory.create":
      return createMemoryFromAction(context.database, action, payload);
    case "no_action":
      return noActionResult(action, payload);
    case "issue_completion_watch.create":
      return createIssueCompletionWatchAction(context.database, payload as IssueCompletionWatchCreateInput);
    case "issue_completion_watch.cancel":
      return cancelIssueCompletionWatchAction(context.database, payload as IssueCompletionWatchCancelInput);
    case "issue.comment":
      return createIssueComment(context.database, positivePayloadID(payload, "issue_id"), payload);
    case "issue.state_repair":
      return applyIssueStateRepair(context.database, actionPayload(action, payload));
    case "issue.completion_reconcile":
      return await reconcileIssueCompletion(context, action, payload);
    case "agent.executor_assign":
      return await updateExecutorIssue(context.database, action, payload);
    case "agent.workflow_request":
      return createWorkflowIssue(context, action, payload);
    case "needs_user.escalate":
      return dispatchNeedsUserEscalation(context, action, payload);
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

async function reconcileIssueCompletion(
  context: PiActionDispatchContext,
  action: PiAction,
  payload: Record<string, unknown>
): Promise<unknown> {
  const issueID = positivePayloadID(payload, "issue_id");
  const result = await reconcileIssueCompletionFromRuntimeEvidence(context.database, issueID, {
    actor: { id: `pi-action:${action.id}`, kind: "supervisor" },
    correlation_id: action.idempotency_key || action.id,
    source: "pi-action-completion-reconciliation"
  });
  if (result.issue.status === "done") startAutoRunProjectLoop(context, result.issue.project_id);
  return {
    issue: {
      id: result.issue.id,
      project_id: result.issue.project_id,
      status: result.issue.status,
      title: result.issue.title
    },
    target_status: result.target_status,
    transition_path: result.transition_path
  };
}

async function updateExecutorIssue(
  db: RunnerDatabase,
  action: PiAction,
  payload: Record<string, unknown>
): Promise<unknown> {
  const issueID = positivePayloadID(payload, "issue_id");
  const patch = objectPayload(payload.patch);
  if (cleanString(patch.status) !== "done") return updateIssue(db, issueID, patch);
  return (await completeIssueFromRuntimeEvidence(db, issueID, patch, {
    actor: { id: `pi-action:${action.id}`, kind: "supervisor" },
    correlation_id: action.idempotency_key || action.id,
    source: "pi-agent-executor-assign"
  })).issue;
}

function actionPayload(action: PiAction, payload: Record<string, unknown>): Record<string, unknown> {
  return { ...payload, action_id: action.id, decision_id: action.guardian_decision_id, idempotency_key: action.idempotency_key };
}

function issueCreatePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const description = cleanString(payload.description) || cleanString(payload.body);
  return { ...payload, description, status: cleanString(payload.status) || "triage" };
}

function lookupIssueStatus(db: RunnerDatabase, payload: Record<string, unknown>): Record<string, unknown> {
  const issueID = positiveInputID(payload.issue_id);
  if (issueID) return { item: getIssue(db, issueID) };
  const projectID = cleanString(payload.project_id);
  const status = cleanString(payload.status);
  const query = cleanString(payload.query).toLowerCase();
  const items = listIssues(db, { projectId: projectID, status })
    .filter((issue) => query === "" || issue.title.toLowerCase().includes(query) ||
      issue.description.toLowerCase().includes(query))
    .slice(0, 10);
  return { items, query };
}

function replyDraftPayload(actionPayload: Record<string, unknown>, action: PiAction): Record<string, unknown> {
  const text = cleanString(actionPayload.content) || cleanString(actionPayload.draft) ||
    cleanString(actionPayload.text) || cleanString(actionPayload.message);
  return {
    approval_action_id: action.id,
    content: text,
    created_by: cleanString(actionPayload.created_by) || "pi_action",
    external_event_id: positiveInputID(actionPayload.external_event_id) || 0,
    issue_id: positiveInputID(actionPayload.issue_id) || action.issue_id || 0,
    risk: cleanString(actionPayload.risk) || action.risk_level,
    source: cleanString(actionPayload.source) || action.source,
    target_chat_id: cleanString(actionPayload.target_chat_id),
    target_message_id: cleanString(actionPayload.target_message_id),
    target_thread_id: cleanString(actionPayload.target_thread_id)
  };
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

function enqueueIssueAndStartAutoRun(context: PiActionDispatchContext, action: PiAction, issueID: number): unknown {
  const issue = enqueueIssue(context.database, issueID);
  startEnqueuedProjectLoop(context, action, issue.project_id);
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
  startProjectLoopWhenAllowed(context, projectID);
}

function startEnqueuedProjectLoop(
  context: PiActionDispatchContext,
  action: PiAction,
  projectID: string
): void {
  const options = runnerChatAction(action) ? { forceOnce: true } : undefined;
  startProjectLoopWhenAllowed(context, projectID, options);
}

function startProjectLoopWhenAllowed(
  context: PiActionDispatchContext,
  projectID: string,
  options?: ProjectLoopStartOptions
): void {
  const project = getProject(context.database, projectID);
  const providerID = project?.provider ?? "";
  if (!project || !isExecutorProviderId(providerID)) return;
  if (!context.providers?.[providerID]?.capabilities.includes("issue_execution")) return;
  if (!shouldStartProjectLoop(project, options)) return;
  const starter = context.startProjectLoop ?? defaultStartProjectLoop;
  starter({ bus: context.bus, database: context.database, providers: context.providers }, project.id, options);
}

function shouldStartProjectLoop(project: Project, options?: ProjectLoopStartOptions): boolean {
  return options?.forceOnce === true || project.auto_run === 1;
}

function runnerChatAction(action: PiAction): boolean {
  return isRunnerChatSource(action.source) || action.conversation_id.startsWith("feishu-");
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
