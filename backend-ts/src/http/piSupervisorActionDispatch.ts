import type { RunnerDatabase } from "../db/database.ts";
import { getAgentSession, upsertAgentSession } from "../db/repositories/agentSessions.ts";
import { retryIssue } from "../db/repositories/issueActions.ts";
import { recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { getIssue, listIssueRuns, type Issue, type IssueRun } from "../db/repositories/issues.ts";
import { updateIssueRuntime } from "../db/repositories/issueRuns.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { createIssueSupervisorEvent, type PiAction } from "../db/repositories/pi.ts";
import {
  isExecutorProviderId,
  type ExecutorProvider,
  type ExecutorProviderId,
  type SessionMessageResult
} from "../providers/types.ts";

export type SupervisorDispatchContext = {
  database: RunnerDatabase;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};

export async function dispatchSupervisorPiAction(
  context: SupervisorDispatchContext,
  action: PiAction,
  payload: Record<string, unknown>
): Promise<unknown> {
  if (action.action_type === "session.resume_followup") return resumeSessionFollowup(context, action, payload);
  if (action.action_type === "issue.retry") return retryIssueNow(context, action, payload);
  if (action.action_type === "issue.retry_after") return scheduleRetryAfter(context, action, payload);
  if (action.action_type === "issue.supervisor_decision") return recordSupervisorDecision(context, action, payload);
  throw new Error(`unsupported supervisor PI action type: ${action.action_type}`);
}

async function resumeSessionFollowup(
  context: SupervisorDispatchContext,
  action: PiAction,
  payload: Record<string, unknown>
): Promise<unknown> {
  const issueID = positivePayloadID(payload, "issue_id");
  const providerID = sessionProviderID(payload);
  const sessionID = sessionProviderSessionID(payload);
  assertFreshSupervisorState(context.database, issueID, providerID, sessionID, payload, [
    "expected_issue_updated_at", "expected_run_id", "expected_provider_turn_id", "expected_session_updated_at"
  ]);
  const prompt = requiredText(payload.prompt, "prompt");
  const provider = context.providers?.[providerID];
  if (!provider?.sendSessionMessage) throw new Error(`provider "${providerID}" 不支持 capability "resume_session"`);
  const result = await provider.sendSessionMessage({ prompt, sessionId: sessionID });
  persistFollowupRuntime(context.database, { action, issueID, providerID, result, sessionID });
  recordIssueEvent(context.database, issueID, "issue.supervisor_resume_followup", {
    action_id: action.id,
    decision_id: cleanString(payload.decision_id),
    provider: providerID,
    provider_session_id: sessionID,
    provider_turn_id: result.turn_id
  });
  recordSupervisorResult(context.database, action, payload, { outcome: "started", provider_turn_id: result.turn_id });
  return result;
}

function retryIssueNow(
  context: SupervisorDispatchContext,
  action: PiAction,
  payload: Record<string, unknown>
): unknown {
  const issueID = positivePayloadID(payload, "issue_id");
  assertFreshSupervisorState(context.database, issueID, sessionProviderID(payload), "", payload, [
    "expected_issue_updated_at", "expected_run_id"
  ]);
  const reason = cleanString(payload.reason) || cleanString(payload.diagnosis_code) || "supervisor retry";
  const issue = retryIssue(context.database, issueID);
  recordIssueEvent(context.database, issueID, "issue.supervisor_retry", {
    action_id: action.id,
    decision_id: cleanString(payload.decision_id),
    reason
  });
  recordSupervisorResult(context.database, action, payload, { outcome: "queued", reason, status: issue.status });
  return issue;
}

function scheduleRetryAfter(
  context: SupervisorDispatchContext,
  action: PiAction,
  payload: Record<string, unknown>
): unknown {
  const issueID = positivePayloadID(payload, "issue_id");
  assertFreshSupervisorState(context.database, issueID, sessionProviderID(payload), "", payload, [
    "expected_issue_updated_at", "expected_run_id"
  ]);
  const retryAfterAt = requiredTime(payload.retry_after_at, "retry_after_at");
  const reason = requiredText(payload.reason, "reason");
  const issue = updateIssue(context.database, issueID, { auto_retry_next_at: retryAfterAt, auto_retry_reason: reason });
  recordIssueEvent(context.database, issueID, "issue.retry_after_scheduled", {
    action_id: action.id,
    reason,
    retry_after_at: retryAfterAt,
    source_event_id: payload.source_event_id
  });
  recordSupervisorResult(context.database, action, payload, { outcome: "scheduled", retry_after_at: retryAfterAt });
  return issue;
}

function recordSupervisorDecision(
  context: SupervisorDispatchContext,
  action: PiAction,
  payload: Record<string, unknown>
): unknown {
  const issueID = positivePayloadID(payload, "issue_id");
  assertFreshSupervisorState(context.database, issueID, sessionProviderID(payload), "", payload, [
    "expected_issue_updated_at", "expected_run_id"
  ]);
  recordIssueEvent(context.database, issueID, "issue.supervisor_decision", {
    action_id: action.id,
    decision: payload.decision
  });
  recordSupervisorResult(context.database, action, payload, { outcome: "recorded" });
  return { recorded: true };
}

function assertFreshSupervisorState(
  db: RunnerDatabase,
  issueID: number,
  provider: ExecutorProviderId,
  sessionID: string,
  payload: Record<string, unknown>,
  requiredKeys: string[] = []
): void {
  const issue = getIssue(db, issueID);
  if (!issue) throw new Error(`issue ${issueID} not found`);
  const latestRun = listIssueRuns(db, issueID).at(-1);
  assertPreconditionsPresent(payload, requiredKeys);
  assertIssueSnapshot(issue, payload);
  assertRunSnapshot(latestRun, payload);
  if (sessionID !== "") assertSessionSnapshot(db, provider, sessionID, payload);
}

function assertPreconditionsPresent(payload: Record<string, unknown>, keys: string[]): void {
  const missing = keys.filter((key) => cleanString(payload[key]) === "");
  if (missing.length > 0) throw new Error(`supervisor action precondition missing: ${missing.join(", ")}`);
}

function assertIssueSnapshot(issue: Issue, payload: Record<string, unknown>): void {
  assertExpected("issue changed before PI action execution", payload.expected_issue_updated_at, issue.updated_at);
  assertExpected("issue changed before PI action execution", payload.expected_issue_status, issue.status);
}

function assertRunSnapshot(run: IssueRun | undefined, payload: Record<string, unknown>): void {
  const expectedRunID = cleanString(payload.expected_run_id);
  if (expectedRunID !== "" && run?.id !== expectedRunID) throw new Error("run changed before PI action execution");
  assertExpected("run changed before PI action execution", payload.expected_provider_session_id, run?.provider_session_id ?? "");
  assertExpected("run changed before PI action execution", payload.expected_provider_turn_id, run?.provider_turn_id ?? "");
  assertExpected("run changed before PI action execution", payload.expected_run_status, run?.status ?? "");
  assertExpected("run changed before PI action execution", payload.expected_run_ended_at, run?.ended_at ?? "");
}

function assertSessionSnapshot(
  db: RunnerDatabase,
  provider: ExecutorProviderId,
  sessionID: string,
  payload: Record<string, unknown>
): void {
  const session = getAgentSession(db, `${provider}:${sessionID}`);
  assertExpected("session changed before PI action execution", payload.expected_session_updated_at, session?.updated_at ?? "");
  assertExpected("session changed before PI action execution", payload.expected_session_status, session?.status ?? "");
  assertExpected("session changed before PI action execution", payload.expected_session_turn_id, rawRefTurnID(session?.raw_ref));
}

function persistFollowupRuntime(
  db: RunnerDatabase,
  input: {
    action: PiAction;
    issueID: number;
    providerID: ExecutorProviderId;
    result: SessionMessageResult;
    sessionID: string;
  }
): void {
  const sessionID = cleanString(input.result.provider_session_id) || cleanString(input.result.sessionId) || input.sessionID;
  if (sessionID === "" || input.result.turn_id === "") return;
  updateIssueRuntime(db, input.issueID, {
    metadata: { supervisor_action_id: input.action.id, supervisor_recovery: true },
    provider: input.result.provider || input.providerID,
    provider_session_id: sessionID,
    provider_turn_id: input.result.turn_id
  });
  upsertAgentSession(db, {
    issue_id: input.issueID,
    project_id: input.action.project_id,
    provider: input.result.provider || input.providerID,
    provider_session_id: sessionID,
    raw_ref: { provider_turn_id: input.result.turn_id, supervisor_action_id: input.action.id },
    status: "running"
  });
}

function recordSupervisorResult(
  db: RunnerDatabase,
  action: PiAction,
  payload: Record<string, unknown>,
  result: Record<string, unknown>
): void {
  createIssueSupervisorEvent(db, {
    action_id: action.id,
    action_type: action.action_type,
    decision: decisionText(payload),
    diagnosis_code: cleanString(payload.diagnosis_code),
    event_type: "result",
    issue_id: action.issue_id || positiveInputID(payload.issue_id) || 0,
    payload_json: result,
    project_id: action.project_id,
    provider: cleanString(payload.provider),
    provider_session_id: cleanString(payload.provider_session_id),
    provider_turn_id: cleanString(result.provider_turn_id) || cleanString(payload.provider_turn_id),
    retry_after_at: cleanString(result.retry_after_at) || cleanString(payload.retry_after_at)
  });
}

function assertExpected(message: string, expected: unknown, actual: string): void {
  const text = cleanString(expected);
  if (text !== "" && text !== actual) throw new Error(message);
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

function decisionText(payload: Record<string, unknown>): string {
  const direct = cleanString(payload.decision);
  if (direct !== "") return direct;
  return cleanString(objectPayload(payload.decision).decision);
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

function requiredText(value: unknown, key: string): string {
  const text = cleanString(value);
  if (text === "") throw new Error(`${key} is required`);
  return text;
}

function requiredTime(value: unknown, key: string): string {
  const text = requiredText(value, key);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${key} must be a valid time`);
  return text;
}

function rawRefTurnID(rawRef: string | undefined): string {
  if (!rawRef) return "";
  try { return cleanString((JSON.parse(rawRef) as Record<string, unknown>).provider_turn_id); } catch { return ""; }
}

function sessionIDFromKey(sessionKey: string): string {
  const separator = sessionKey.indexOf(":");
  return separator < 0 ? sessionKey : sessionKey.slice(separator + 1).trim();
}

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
