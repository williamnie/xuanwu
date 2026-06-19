import type { RunnerDatabase } from "../db/database.ts";
import { listIssueRuns } from "../db/repositories/issues.ts";
import type { IssueRun } from "../db/repositories/issues.ts";
import type { PiAction } from "../db/repositories/pi.ts";
import {
  recordPiRecoveryAttempt,
  type PiRecoveryAttempt,
  type PiRecoveryAttemptStatus
} from "../db/repositories/pi/recoveryAttempts.ts";
import { readPiRecoveryBudget } from "../pi/recoveryBudget.ts";

export function prepareIssueRecoveryAttempt(
  db: RunnerDatabase,
  action: PiAction,
  payload: Record<string, unknown>,
  input: { actionType: string; hardTimeoutAt?: string; issueID: number; status: PiRecoveryAttemptStatus }
): PiRecoveryAttempt {
  assertRecoveryBudget(db, action, payload, input);
  const timestamp = new Date().toISOString();
  return recordPiRecoveryAttempt(db, {
    action_type: input.actionType,
    before_snapshot_json: issueRecoverySnapshot(db, input.issueID, payload),
    budget_window_started_at: timestamp,
    diagnosis_code: diagnosisCode(payload, input.actionType),
    executing_started_at: input.status === "executing" ? timestamp : "",
    hard_timeout_at: clean(input.hardTimeoutAt),
    id: `recovery-${action.id}`,
    idempotency_key: recoveryAttemptKey(action, payload, input.actionType),
    issue_id: input.issueID,
    project_id: action.project_id,
    provider_session_id: clean(payload.provider_session_id) || latestRun(db, input.issueID)?.provider_session_id,
    provider_turn_id: clean(payload.provider_turn_id) || latestRun(db, input.issueID)?.provider_turn_id,
    run_id: clean(payload.expected_run_id) || latestRun(db, input.issueID)?.id,
    session_id: sessionKey(payload, latestRun(db, input.issueID)),
    source_decision_id: clean(payload.decision_id) || action.guardian_decision_id || action.id,
    status: input.status
  });
}

export function issueRecoverySnapshot(
  db: RunnerDatabase,
  issueID: number,
  payload: Record<string, unknown>
): Record<string, unknown> {
  const row = db.sqlite.query<{ status: string; updated_at: string }, [number]>(
    "select status, updated_at from issues where id=?"
  ).get(issueID);
  const run = latestRun(db, issueID);
  return {
    issue: { status: row?.status ?? "", updated_at: row?.updated_at ?? clean(payload.expected_issue_updated_at) },
    run: { status: run?.status ?? "", updated_at: run?.ended_at || run?.started_at || "" },
    session: { status: clean(payload.expected_session_status), updated_at: clean(payload.expected_session_updated_at) }
  };
}

function assertRecoveryBudget(
  db: RunnerDatabase,
  action: PiAction,
  payload: Record<string, unknown>,
  input: { actionType: string; issueID: number }
): void {
  const budget = readPiRecoveryBudget(db, {
    actionType: input.actionType,
    issueID: input.issueID,
    now: new Date(),
    projectID: action.project_id,
    sessionID: sessionKey(payload, latestRun(db, input.issueID))
  });
  if (budget.status === "allow") return;
  if (budget.status === "project_budget_exhausted") throw new Error("project recovery budget is exhausted");
  throw new Error("recovery budget is exhausted");
}

function latestRun(db: RunnerDatabase, issueID: number): IssueRun | undefined {
  return listIssueRuns(db, issueID).at(-1);
}

function recoveryAttemptKey(action: PiAction, payload: Record<string, unknown>, actionType: string): string {
  return [
    "recovery",
    actionType,
    positiveID(payload.issue_id) || action.issue_id,
    clean(payload.decision_id) || action.guardian_decision_id || action.id
  ].join(":");
}

function sessionKey(payload: Record<string, unknown>, run: IssueRun | undefined): string {
  const provider = clean(payload.provider) || run?.provider || "codex";
  const sessionID = clean(payload.provider_session_id) || run?.provider_session_id || "";
  return sessionID === "" ? "" : `${provider}:${sessionID}`;
}

function diagnosisCode(payload: Record<string, unknown>, fallback: string): string {
  return clean(payload.diagnosis_code) || clean(payload.reason) || fallback;
}

function positiveID(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  const parsed = Number.parseInt(clean(value), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
