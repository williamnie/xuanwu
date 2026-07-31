import type { RunnerDatabase } from "../db/database.ts";
import { enqueueIssue, retryIssue } from "../db/repositories/issueActions.ts";
import { createIssueComment, recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { hasActiveExecutorWork } from "../db/repositories/issueQueue.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { recordPiRecoveryAttempt, updatePiRecoveryAttemptStatus } from "../db/repositories/pi/recoveryAttempts.ts";
import type { IssueStateRepairOperation } from "./issueStateManager.ts";
import { applyIssueCompletionGate } from "../domain/evidence/completionGate.ts";
import {
  currentIssueStateSnapshot,
  issueStateSnapshotDiff,
  issueStateSnapshotsEqual,
  normalizeIssueStateSnapshot,
  stableJson,
  type IssueStateSnapshot
} from "./issueStateSnapshot.ts";

export function applyIssueStateRepair(db: RunnerDatabase, payload: Record<string, unknown>): unknown {
  const issueID = positiveID(payload.issue_id);
  const operation = cleanString(payload.operation) as IssueStateRepairOperation;
  const expected = normalizeIssueStateSnapshot(payload.expected_state);
  const before = currentIssueStateSnapshot(db, issueID);
  assertExpectedState(expected, before);
  assertSafeTerminalRepair(operation, payload, before);
  const attempt = recordStateRepairAttempt(db, issueID, operation, payload, before);
  const result = executeRepair(db, issueID, operation, payload);
  const after = currentIssueStateSnapshot(db, issueID);
  updatePiRecoveryAttemptStatus(db, attempt.id, {
    after_snapshot_json: after,
    progress_detected: issueStateSnapshotsEqual(before, after) ? 0 : 1,
    progress_reasons_json: issueStateSnapshotsEqual(before, after) ? [] : ["issue_state_changed"],
    status: "progress"
  });
  recordIssueEvent(db, issueID, "issue.state_manager_repair", repairAudit(db, operation, payload, before, after));
  return result;
}

function executeRepair(
  db: RunnerDatabase,
  issueID: number,
  operation: IssueStateRepairOperation,
  payload: Record<string, unknown>
): unknown {
  if (operation === "enqueue") return enqueueIssue(db, issueID);
  if (operation === "retry") return retryIssue(db, issueID);
  const patch = objectPayload(payload.patch);
  if (operation === "move_status" || operation === "patch_status") {
    reconcileTerminalRuntime(db, issueID, payload, patch);
    if (cleanString(patch.status) === "done") {
      const now = new Date().toISOString();
      return applyIssueCompletionGate(db, issueID, {
        actor: { id: "pi-state-repair", kind: "supervisor" },
        correlation_id: cleanString(payload.action_id) || `issue-${issueID}-state-repair`,
        evidence: [],
        now,
        patch,
        projection_errors: ["legacy state-repair evidence is not trusted structured Evidence"],
        source: "pi-state-repair"
      }).issue;
    }
    return updateIssue(db, issueID, patch);
  }
  if (operation === "comment") return createIssueComment(db, issueID, {
    author: "agent",
    body: cleanString(patch.body) || cleanString(payload.rationale)
  });
  throw new Error("unsupported issue state repair operation");
}

function repairAudit(
  db: RunnerDatabase,
  operation: IssueStateRepairOperation,
  payload: Record<string, unknown>,
  before: IssueStateSnapshot,
  after: IssueStateSnapshot
): Record<string, unknown> {
  return {
    action_id: cleanString(payload.action_id),
    after_snapshot: after,
    before_snapshot: before,
    diagnosis_code: cleanString(payload.diagnosis_code),
    evidence: Array.isArray(payload.evidence) ? payload.evidence : [],
    operation,
    runner_executor_busy: hasActiveExecutorWork(db)
  };
}

function assertExpectedState(expected: IssueStateSnapshot, actual: IssueStateSnapshot): void {
  if (issueStateSnapshotsEqual(expected, actual)) return;
  throw new Error(`issue.state_repair precondition changed: ${issueStateSnapshotDiff(expected, actual)}`);
}

function assertSafeTerminalRepair(
  operation: IssueStateRepairOperation,
  payload: Record<string, unknown>,
  before: IssueStateSnapshot
): void {
  const nextStatus = cleanString(objectPayload(payload.patch).status);
  if (!["move_status", "patch_status"].includes(operation) || !terminalStatus(nextStatus)) return;
  if (hasActiveRuntime(before, payload)) throw new Error("issue.state_repair cannot set terminal status while runtime is active");
  if (nextStatus === "done" && !allowsVerifiedDone(payload)) {
    throw new Error("issue.state_repair cannot mark done without deterministic verification evidence");
  }
}

function recordStateRepairAttempt(
  db: RunnerDatabase,
  issueID: number,
  operation: IssueStateRepairOperation,
  payload: Record<string, unknown>,
  before: IssueStateSnapshot
) {
  const timestamp = new Date().toISOString();
  return recordPiRecoveryAttempt(db, {
    action_type: "issue.state_repair",
    before_snapshot_json: before,
    budget_window_started_at: timestamp,
    diagnosis_code: requiredString(payload.diagnosis_code, "diagnosis_code"),
    executing_started_at: timestamp,
    hard_timeout_at: timestamp,
    id: attemptID(payload, issueID),
    idempotency_key: attemptKey(payload, issueID, operation, before),
    issue_id: issueID,
    project_id: before.issue.project_id,
    provider_session_id: before.run?.provider_session_id ?? before.session?.provider_session_id ?? "",
    provider_turn_id: before.run?.provider_turn_id ?? "",
    run_id: before.run?.id ?? "",
    session_id: before.session?.session_key ?? "",
    source_decision_id: cleanString(payload.decision_id) || cleanString(payload.action_id),
    status: "executing"
  });
}

function attemptID(payload: Record<string, unknown>, issueID: number): string {
  const actionID = cleanString(payload.action_id);
  return actionID === "" ? crypto.randomUUID() : `recovery-${actionID}-${issueID}`;
}

function attemptKey(
  payload: Record<string, unknown>,
  issueID: number,
  operation: IssueStateRepairOperation,
  before: IssueStateSnapshot
): string {
  const explicit = cleanString(payload.idempotency_key);
  if (explicit !== "") return `state-repair:${explicit}`;
  return [
    "state-repair",
    cleanString(payload.diagnosis_code),
    issueID,
    operation,
    Bun.hash(stableJson(before), 0).toString(16)
  ].join(":");
}

function hasActiveRuntime(snapshot: IssueStateSnapshot, payload: Record<string, unknown>): boolean {
  const sessionStatus = normalize(snapshot.session?.status ?? "");
  const terminalMismatch = cleanString(payload.diagnosis_code) === "in_progress_session_ended" &&
    TERMINAL_SESSION_STATUSES.has(sessionStatus);
  if (terminalMismatch) return false;
  return snapshot.run?.ended_at === "" || ACTIVE_SESSION_STATUSES.has(sessionStatus);
}

function allowsVerifiedDone(payload: Record<string, unknown>): boolean {
  return cleanString(payload.diagnosis_code) === "pending_verification_has_evidence";
}

function terminalStatus(status: string): boolean {
  return status === "done" || status === "failed" || status === "cancelled" || status === "pending_verification";
}

function reconcileTerminalRuntime(
  db: RunnerDatabase,
  issueID: number,
  payload: Record<string, unknown>,
  patch: Record<string, unknown>
): void {
  if (cleanString(payload.diagnosis_code) !== "in_progress_session_ended") return;
  const status = cleanString(patch.status);
  if (!terminalStatus(status)) return;
  const before = currentIssueStateSnapshot(db, issueID);
  if (before.run?.ended_at !== "") return;
  if (!TERMINAL_SESSION_STATUSES.has(normalize(before.session?.status ?? ""))) {
    throw new Error("issue.state_repair terminal-session diagnosis is no longer current");
  }
  const timestamp = new Date().toISOString();
  const failed = status === "failed";
  const runStatus = failed ? "failed" : "done";
  const reason = `state_repair:${cleanString(payload.diagnosis_code)}`;
  db.sqlite.run(`update issue_runs set status=?, ended_at=?, exit_reason=?,
    error=case when ?=1 then ? else '' end where id=? and ended_at=''`, [
    runStatus,
    timestamp,
    reason,
    failed ? 1 : 0,
    cleanString(patch.error),
    before.run?.id ?? ""
  ]);
  db.sqlite.run(`update run_attempts set status=?, legacy_status=?, ended_at=?,
    terminal_reason=?, terminal_source_ref=?, revision=revision+1, updated_at=?
    where issue_run_id=? and status not in ('succeeded','failed','interrupted','cancelled','superseded')`, [
    failed ? "failed" : "succeeded",
    runStatus,
    timestamp,
    "provider session reached a terminal state before Runner lifecycle callback",
    `issue-state-repair:${issueID}`,
    timestamp,
    before.run?.id ?? ""
  ]);
  recordIssueEvent(db, issueID, "issue.run_terminal_reconciled", {
    diagnosis_code: cleanString(payload.diagnosis_code),
    issue_run_id: before.run?.id ?? "",
    provider_session_id: before.session?.provider_session_id ?? "",
    provider_session_status: before.session?.status ?? "",
    run_status: runStatus
  });
}

const ACTIVE_SESSION_STATUSES = new Set(["active", "running", "inprogress", "busy"]);
const TERMINAL_SESSION_STATUSES = new Set(["aborted", "cancelled", "completed", "done", "error", "failed", "stopped"]);

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredString(value: unknown, key: string): string {
  const text = cleanString(value);
  if (text === "") throw new Error(`${key} is required`);
  return text;
}

function positiveID(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  throw new Error("issue_id is required");
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[_\s-]/g, "");
}
