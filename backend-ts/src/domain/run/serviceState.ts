import type { RunnerDatabase } from "../../db/database.ts";
import { type RunID, type RunTransitionAudit } from "./contracts.ts";
import { cleanString } from "../../util/values.ts";
import type { AttemptRow, RunRow } from "./lifecycleStore.ts";
import {
  RUN_LIFECYCLE_EVENT_TYPES,
  RunCommandValidationError,
  numeric,
  parsePayload,
  required
} from "./lifecycleStore.ts";
import { type PendingRunCreation, type RunAttemptCommand, type NewRunCommand } from "./serviceModel.ts";

export function readRunRevision(db: RunnerDatabase, issueID: number, runID: RunID): number {
  const row = db.sqlite.query<{ revision: number | null }, [number, string, string, string, string, string]>(`
    select max(cast(json_extract(payload, '$.after_revision') as integer)) as revision
    from issue_events
    where issue_id=?
      and type in (?, ?, ?, ?)
      and json_valid(payload)
      and json_extract(payload, '$.run_id')=?
  `).get(
    issueID,
    RUN_LIFECYCLE_EVENT_TYPES.intent,
    RUN_LIFECYCLE_EVENT_TYPES.outcome,
    RUN_LIFECYCLE_EVENT_TYPES.runMaterialized,
    RUN_LIFECYCLE_EVENT_TYPES.runRequested,
    runID
  );
  return row?.revision ?? 0;
}

export function pendingRunCreation(
  db: RunnerDatabase,
  issueID: number,
  sequence: number
): PendingRunCreation | null {
  const rows = db.sqlite.query<{ payload: string }, [number, string, number, string]>(`
    select request.payload from issue_events request
    where request.issue_id=? and request.type=? and json_valid(request.payload)
      and json_extract(request.payload, '$.requested_sequence')=?
      and json_extract(request.payload, '$.outcome')='applied'
      and not exists (
        select 1 from issue_events materialized
        where materialized.issue_id=request.issue_id and materialized.type=?
          and json_valid(materialized.payload)
          and json_extract(materialized.payload, '$.event_id')=json_extract(request.payload, '$.event_id')
      )
    order by request.id desc limit 1
  `).all(issueID, RUN_LIFECYCLE_EVENT_TYPES.runRequested, sequence, RUN_LIFECYCLE_EVENT_TYPES.runMaterialized);
  if (!rows[0]) return null;
  const payload = parsePayload(rows[0].payload);
  const operation = payload.operation;
  if (operation !== "retry" && operation !== "supersede") return null;
  return {
    event_id: required(payload.event_id, "event_id"),
    issue_id: issueID,
    operation,
    requested_sequence: numeric(payload.requested_sequence, "requested_sequence"),
    supersedes_run_id: required(payload.supersedes_run_id, "supersedes_run_id") as RunID
  };
}

export function pendingNewRunRequest(db: RunnerDatabase, issueID: number): boolean {
  const sequence = nextRunSequence(db, issueID);
  return pendingRunCreation(db, issueID, sequence) !== null;
}

export function closeAttempt(
  db: RunnerDatabase,
  attempt: AttemptRow,
  terminal: RunAttemptCommand["previous_attempt_terminal"],
  timestamp: string
): void {
  if (attempt.status === terminal.status) return;
  if (attempt.status !== "running") throw new RunCommandValidationError(`${attempt.attempt_id} is not running`);
  db.sqlite.run(`update run_attempts set status=?, revision=revision+1, ended_at=?,
    terminal_reason=?, terminal_source_ref=?, updated_at=? where attempt_id=? and status='running'`, [
    terminal.status,
    timestamp,
    required(terminal.reason, "previous_attempt_terminal.reason"),
    required(terminal.source_ref, "previous_attempt_terminal.source_ref"),
    timestamp,
    attempt.attempt_id
  ]);
}

export function closeSupersededRun(
  db: RunnerDatabase,
  run: RunRow,
  attempt: AttemptRow,
  audit: RunTransitionAudit
): void {
  const sequence = nextRunSequence(db, run.issue_id);
  const replacementRunID = `xw:run:issue_runs:issue-${run.issue_id}-attempt-${sequence}`;
  const reason = `superseded_by:${replacementRunID}`;
  db.sqlite.run(`update issue_runs set status='cancelled', ended_at=?, exit_reason=?, error=''
    where id=? and ended_at=''`, [audit.occurred_at, reason, run.legacy_id]);
  // The P03.02 compatibility trigger mirrors a terminal legacy Run into the
  // initial Attempt when no later Attempt exists. Supersede has already
  // interrupted that Attempt, so restore the more precise child fact.
  db.sqlite.run(`update run_attempts set status='interrupted', ended_at=?,
    terminal_reason='provider turn interrupted before supersede',
    terminal_source_ref=?, updated_at=? where attempt_id=?`, [
    audit.occurred_at,
    `run-lifecycle:${audit.event_id}`,
    audit.occurred_at,
    attempt.attempt_id
  ]);
}

export function queueIssueForRun(db: RunnerDatabase, issueID: number, command: NewRunCommand): void {
  const hasTier = command.service_tier_provided === true;
  const tier = cleanString(command.service_tier);
  db.sqlite.run(`update issues set status='todo', error='', codex_thread_id='', codex_turn_id='',
    service_tier=case when ?=1 then ? else service_tier end,
    auto_retry_next_at='', auto_retry_reason='', updated_at=? where id=?`, [
    hasTier ? 1 : 0,
    tier,
    command.audit.occurred_at,
    issueID
  ]);
}

export function recordStatusEvent(
  db: RunnerDatabase,
  issueID: number,
  payload: Record<string, string>,
  timestamp: string
): void {
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, 'issue.status_changed', ?, ?)`,
    [issueID, JSON.stringify(payload), timestamp]
  );
}

export function nextRunSequence(db: RunnerDatabase, issueID: number): number {
  return db.sqlite.query<{ sequence: number }, [number]>(
    "select coalesce(max(attempt), 0) + 1 as sequence from issue_runs where issue_id=?"
  ).get(issueID)?.sequence ?? 1;
}
