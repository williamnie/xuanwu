import type { RunnerDatabase } from "../database.ts";
import type { NormalizedRunEvent } from "../../providers/types.ts";
import { issueTimestamp } from "./issueCreate.ts";

type AttemptRow = { attempt_id: string };

export function projectNormalizedRunEvent(
  db: RunnerDatabase,
  issueRunID: string,
  event: NormalizedRunEvent | undefined,
  issueEventID: number
): void {
  if (!event?.cost || issueRunID.trim() === "") return;
  const attempt = latestAttempt(db, issueRunID);
  if (!attempt) return;
  const sourceRefs = [...new Set([
    ...event.cost.source_refs.map((value) => value.trim()).filter(Boolean),
    `issue_events:${issueEventID}`
  ])];
  const cost = { ...event.cost, source_refs: sourceRefs };
  db.sqlite.run(
    "update run_attempts set cost_json=?, revision=revision+1, updated_at=? where attempt_id=?",
    [JSON.stringify(cost), issueTimestamp(), attempt.attempt_id]
  );
}

function latestAttempt(db: RunnerDatabase, issueRunID: string): AttemptRow | null {
  return db.sqlite.query<AttemptRow, [string]>(`
    select attempt_id from run_attempts
    where issue_run_id=?
    order by sequence desc
    limit 1
  `).get(issueRunID);
}
