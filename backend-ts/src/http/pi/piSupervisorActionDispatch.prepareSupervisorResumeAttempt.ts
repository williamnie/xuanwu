import type { RunnerDatabase } from "../../db/database.ts";
import { upsertAgentSession } from "../../db/repositories/agentSessions.ts";
import { updateIssueRuntime } from "../../db/repositories/issueRuns.ts";
import { prepareRunAttempt, readRunRevision } from "../../domain/run/service.ts";
import type { PreparedProviderMutation } from "../../domain/run/lifecycleStore.ts";
import { createIssueSupervisorEvent, type PiAction } from "../../db/repositories/pi.ts";
import { isExecutorProviderId, type ExecutorProviderId, type SessionMessageResult } from "../../providers/types.ts";
import { cleanString, objectValue } from "../../util/values.ts";

export function prepareSupervisorResumeAttempt(
  db: RunnerDatabase,
  issueID: number,
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
    expected_revision: readRunRevision(db, issueID, runID),
    issue_run_id: issueRunID,
    kind: "recovery",
    previous_attempt_terminal: {
      reason: "previous provider invocation interrupted before Supervisor recovery",
      source_ref: `pi_recovery_attempts:${recoveryAttemptID}`,
      status: "interrupted"
    },
    provider_ref: { provider: providerID, session_ref: sessionID },
    run_id: runID
  });
}

export function resumeLifecycleEventID(action: PiAction): string {
  return `run-resume:${action.id}`;
}

export function persistFollowupRuntime(
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

export function recordSupervisorResult(
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

export function decisionText(payload: Record<string, unknown>): string {
  const direct = cleanString(payload.decision);
  if (direct !== "") return direct;
  return cleanString(objectValue(payload.decision).decision);
}

export function positivePayloadID(payload: Record<string, unknown>, key: string): number {
  const id = payload[key];
  if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return id;
  throw new Error(`${key} is required`);
}

export function positiveInputID(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  const parsed = Number.parseInt(cleanString(value), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function requiredText(value: unknown, key: string): string {
  const text = cleanString(value);
  if (text === "") throw new Error(`${key} is required`);
  return text;
}

export function sessionIDFromKey(sessionKey: string): string {
  const separator = sessionKey.indexOf(":");
  return separator < 0 ? sessionKey : sessionKey.slice(separator + 1).trim();
}
