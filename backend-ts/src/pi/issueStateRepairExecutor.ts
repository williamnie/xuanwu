import type { RunnerDatabase } from "../db/database.ts";
import { enqueueIssue, retryIssue } from "../db/repositories/issueActions.ts";
import { createIssueComment, recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { hasActiveExecutorWork } from "../db/repositories/issueQueue.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { recordPiRecoveryAttempt, updatePiRecoveryAttemptStatus } from "../db/repositories/pi/recoveryAttempts.ts";
import type { IssueStateRepairOperation } from "./issueStateManager.ts";
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
  if (operation === "move_status" || operation === "patch_status") return updateIssue(db, issueID, patch);
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
  if (hasActiveRuntime(before)) throw new Error("issue.state_repair cannot set terminal status while runtime is active");
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

function hasActiveRuntime(snapshot: IssueStateSnapshot): boolean {
  return snapshot.run?.ended_at === "" ||
    ["active", "running", "in_progress", "inprogress", "busy"].includes(normalize(snapshot.session?.status ?? ""));
}

function allowsVerifiedDone(payload: Record<string, unknown>): boolean {
  return cleanString(payload.diagnosis_code) === "pending_verification_has_evidence";
}

function terminalStatus(status: string): boolean {
  return status === "done" || status === "failed" || status === "cancelled" || status === "pending_verification";
}

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
