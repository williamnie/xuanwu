import type { Database as SQLiteDatabase } from "bun:sqlite";

export const RUN_REVISION_EVENT_TYPES = [
  "run.lifecycle.intent.v1",
  "run.lifecycle.outcome.v1",
  "run.lifecycle.run_materialized.v1",
  "run.lifecycle.run_requested.v1"
] as const;

export type RunRevisionIssueScopeMismatch = {
  event_id: number;
  event_issue_id: number;
  run_id: string;
  run_issue_id: number;
};

export function findRunRevisionIssueScopeMismatches(
  sqlite: SQLiteDatabase,
  limit = 20
): RunRevisionIssueScopeMismatch[] {
  const boundedLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 1000) : 20;
  return sqlite.query<RunRevisionIssueScopeMismatch, [string, string, string, string, number]>(`
    select event.id as event_id, event.issue_id as event_issue_id,
      json_extract(event.payload, '$.run_id') as run_id, run.issue_id as run_issue_id
    from issue_events event
    join issue_runs run on run.run_id=json_extract(event.payload, '$.run_id')
    where event.type in (?, ?, ?, ?)
      and json_valid(event.payload)
      and event.issue_id<>run.issue_id
    order by event.id asc
    limit ?
  `).all(...RUN_REVISION_EVENT_TYPES, boundedLimit);
}
