import type { RunnerDatabase } from "../db/database.ts";
import { upsertAgentSession } from "../db/repositories/agentSessions.ts";
import { recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { updateIssueRuntime } from "../db/repositories/issueRuns.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import {
  completeRunAttemptStart,
  failRunAttemptStart,
  prepareRunAttempt,
  readRunRevision,
  type PreparedProviderMutation
} from "../domain/run/service.ts";
import { createIssueSupervisorEvent, type PiAction } from "../db/repositories/pi.ts";
import { updatePiRecoveryAttemptStatus } from "../db/repositories/pi/recoveryAttempts.ts";
import {
  isExecutorProviderId,
  type ExecutorProvider,
  type ExecutorProviderId,
  type SessionMessageResult
} from "../providers/types.ts";
import {
  markResumeFollowupAttemptStarted,
  prepareResumeFollowupAttempt,
  resolveResumeFollowupReplay
} from "./piSupervisorResumeIdempotency.ts";
import { prepareIssueRecoveryAttempt, issueRecoverySnapshot } from "./piSupervisorIssueRecoveryAttempts.ts";
import { assertFreshSupervisorState } from "./piSupervisorPreconditions.ts";
import { retryIssueWithInterrupt } from "../runner/interrupt.ts";

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
  const prompt = requiredText(payload.prompt, "prompt");
  const provider = context.providers?.[providerID];
  if (!provider?.sendSessionMessage) throw new Error(`provider "${providerID}" 不支持 capability "resume_session"`);
  const replay = await resolveResumeFollowupReplay(context.database, { action, issueID, payload, provider, providerID, sessionID });
  if (replay) {
    recordSupervisorResult(context.database, action, payload, replay.result);
    return replay.result;
  }
  assertFreshSupervisorState(context.database, issueID, providerID, sessionID, payload, [
    "expected_issue_updated_at", "expected_run_id", "expected_provider_turn_id", "expected_session_updated_at"
  ]);
  const prepared = await prepareResumeFollowupAttempt(context.database, { action, issueID, payload, provider, providerID, sessionID });
  if (prepared.skip) {
    recordSupervisorResult(context.database, action, payload, prepared.result);
    return prepared.result;
  }
  const lifecycle = prepareSupervisorResumeAttempt(
    context.database,
    action,
    payload,
    prepared.attempt.id,
    providerID,
    sessionID
  );
  if (!lifecycle.should_invoke) {
    const skipped = {
      outcome: lifecycle.completed ? "already_started" : "attempt_executing",
      provider_turn_id: "",
      skipped: true
    };
    recordSupervisorResult(context.database, action, payload, skipped);
    return skipped;
  }
  let result: SessionMessageResult;
  try {
    result = await provider.sendSessionMessage({ prompt, sessionId: sessionID });
    const turnID = requiredText(result.turn_id, "provider turn id");
    completeRunAttemptStart(context.database, resumeLifecycleEventID(action), {
      invocation_ref: `${providerID}:${sessionID}:${turnID}`,
      provider_session_id: cleanString(result.provider_session_id) || cleanString(result.sessionId) || sessionID,
      provider_turn_id: turnID
    });
    persistFollowupRuntime(context.database, { action, issueID, providerID, result, sessionID });
    markResumeFollowupAttemptStarted(context.database, prepared.attempt.id, turnID);
  } catch (error) {
    failRunAttemptStart(context.database, resumeLifecycleEventID(action), error);
    updatePiRecoveryAttemptStatus(context.database, prepared.attempt.id, { error: safeError(error), status: "failed" });
    throw error;
  }
  const turnID = cleanString(result.turn_id);
  recordIssueEvent(context.database, issueID, "issue.supervisor_resume_followup", {
    action_id: action.id,
    decision_id: cleanString(payload.decision_id),
    provider: providerID,
    provider_session_id: sessionID,
    provider_turn_id: turnID
  });
  recordSupervisorResult(context.database, action, payload, { outcome: "started", provider_turn_id: turnID });
  return result;
}

function prepareSupervisorResumeAttempt(
  db: RunnerDatabase,
  action: PiAction,
  payload: Record<string, unknown>,
  recoveryAttemptID: string,
  providerID: ExecutorProviderId,
  sessionID: string
): PreparedProviderMutation {
  const issueRunID = requiredText(payload.expected_run_id, "expected_run_id");
  const run = db.sqlite.query<{ provider: string; run_id: string }, [string]>(
    "select provider, run_id from issue_runs where id=?"
  ).get(issueRunID);
  if (!run?.run_id.startsWith("xw:run:")) throw new Error(`Run ${issueRunID} 不存在`);
  const attempt = db.sqlite.query<{
    provider_session_id: string;
    revision: number;
    status: string | null;
  }, [string]>(`
    select revision, status, provider_session_id from run_attempts
    where issue_run_id=? order by sequence desc limit 1
  `).get(issueRunID);
  if (!attempt) throw new Error(`Run ${issueRunID} 缺少 Attempt`);
  const runID = run.run_id as `xw:run:${string}:${string}`;
  return prepareRunAttempt(db, {
    audit: {
      actor: { id: action.id, kind: "guardian" },
      correlation_id: cleanString(payload.decision_id) || action.guardian_decision_id || action.id,
      event_id: resumeLifecycleEventID(action),
      gate: {
        authority: "deterministic_policy",
        decision: "allow",
        policy_ref: "run-lifecycle:p03.04:pi-resume-preconditions"
      },
      occurred_at: new Date().toISOString(),
      reason: "Supervisor resume follow-up"
    },
    expected_attempt_revision: attempt.revision,
    expected_revision: readRunRevision(db, runID),
    issue_run_id: issueRunID,
    kind: "resume",
    previous_attempt_terminal: {
      reason: "previous provider turn completed before Supervisor follow-up",
      source_ref: `pi_recovery_attempts:${recoveryAttemptID}`,
      status: "succeeded"
    },
    provider_ref: { provider: providerID, session_ref: sessionID },
    run_id: runID
  });
}

function resumeLifecycleEventID(action: PiAction): string {
  return `run-resume:${action.id}`;
}

async function retryIssueNow(
  context: SupervisorDispatchContext,
  action: PiAction,
  payload: Record<string, unknown>
): Promise<unknown> {
  const issueID = positivePayloadID(payload, "issue_id");
  assertFreshSupervisorState(context.database, issueID, sessionProviderID(payload), "", payload, [
    "expected_issue_updated_at", "expected_run_id"
  ]);
  const reason = cleanString(payload.reason) || cleanString(payload.diagnosis_code) || "supervisor retry";
  const attempt = prepareIssueRecoveryAttempt(context.database, action, payload, {
    actionType: "issue.retry",
    issueID,
    status: "executing"
  });
  try {
    const issue = await retryIssueWithInterrupt(context.database, issueID, {}, { providers: context.providers });
    updatePiRecoveryAttemptStatus(context.database, attempt.id, {
      after_snapshot_json: issueRecoverySnapshot(context.database, issueID, payload),
      progress_detected: 1,
      progress_reasons_json: ["issue_requeued"],
      status: "progress"
    });
    recordIssueEvent(context.database, issueID, "issue.supervisor_retry", {
      action_id: action.id,
      decision_id: cleanString(payload.decision_id),
      reason
    });
    recordSupervisorResult(context.database, action, payload, { outcome: "queued", reason, status: issue.status });
    return issue;
  } catch (error) {
    updatePiRecoveryAttemptStatus(context.database, attempt.id, { error: safeError(error), status: "failed" });
    throw error;
  }
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
  const attempt = prepareIssueRecoveryAttempt(context.database, action, payload, {
    actionType: "issue.retry_after",
    hardTimeoutAt: retryAfterAt,
    issueID,
    status: "planned"
  });
  try {
    const issue = updateIssue(context.database, issueID, { auto_retry_next_at: retryAfterAt, auto_retry_reason: reason });
    recordIssueEvent(context.database, issueID, "issue.retry_after_scheduled", {
      action_id: action.id,
      reason,
      retry_after_at: retryAfterAt,
      source_event_id: payload.source_event_id
    });
    recordSupervisorResult(context.database, action, payload, { outcome: "scheduled", retry_after_at: retryAfterAt });
    return issue;
  } catch (error) {
    updatePiRecoveryAttemptStatus(context.database, attempt.id, { error: safeError(error), status: "failed" });
    throw error;
  }
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

function sessionIDFromKey(sessionKey: string): string {
  const separator = sessionKey.indexOf(":");
  return separator < 0 ? sessionKey : sessionKey.slice(separator + 1).trim();
}

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
