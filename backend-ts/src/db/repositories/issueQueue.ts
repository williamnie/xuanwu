import type { RunnerDatabase } from "../database.ts";
import { issueTimestamp } from "./issueCreate.ts";
import { createIssueRun } from "./issueRuns.ts";
import { getIssue, type Issue } from "./issues.ts";

const STATUS_TODO = "todo";
const STATUS_IN_PROGRESS = "in_progress";

type ClaimedIssueRow = { id: number };

export function claimNextIssue(db: RunnerDatabase, projectID: string): Issue | null {
  const cleanProjectID = projectID.trim();
  if (cleanProjectID === "") throw new Error("project id is required");
  const claim = db.transaction((id: string) => claimNextIssueID(db, id));
  const issueID = claim.immediate(cleanProjectID);
  return issueID > 0 ? getIssue(db, issueID) : null;
}

function claimNextIssueID(db: RunnerDatabase, projectID: string): number {
  const row = nextIssueRow(db, projectID);
  if (!row) return 0;
  const timestamp = issueTimestamp();
  db.sqlite.run(`update issues set status=?, attempt_count=attempt_count+1,
    auto_retry_next_at='', auto_retry_reason='', error='', updated_at=?
    where id=? and status=?`, [STATUS_IN_PROGRESS, timestamp, row.id, STATUS_TODO]);
  createIssueRun(db, row.id);
  recordClaimEvent(db, row.id, timestamp);
  return row.id;
}

function nextIssueRow(db: RunnerDatabase, projectID: string): ClaimedIssueRow | null {
  return db.sqlite.query<ClaimedIssueRow, [string, string]>(`
    select id from issues where project_id=? and status=?
    order by priority desc, created_at asc, id asc limit 1
  `).get(projectID, STATUS_TODO) ?? null;
}

function recordClaimEvent(db: RunnerDatabase, issueID: number, timestamp: string): void {
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [issueID, "issue.status_changed", JSON.stringify({ status: STATUS_IN_PROGRESS }), timestamp]
  );
}
