import type { RunnerDatabase } from "../database.ts";
import { issueTimestamp } from "./issueCreate.ts";
import { createIssueRun } from "./issueRuns.ts";
import { getIssue, type Issue } from "./issues.ts";

const STATUS_TODO = "todo";
const STATUS_IN_PROGRESS = "in_progress";

type ClaimedIssueRow = { id: number };
type CountRow = { count: number };

export function claimNextIssue(db: RunnerDatabase, projectID: string): Issue | null {
  const cleanProjectID = projectID.trim();
  if (cleanProjectID === "") throw new Error("project id is required");
  const claim = db.transaction((id: string) => claimNextIssueID(db, id));
  const issueID = claim.immediate(cleanProjectID);
  return issueID > 0 ? getIssue(db, issueID) : null;
}

export function hasActiveExecutorWork(db: RunnerDatabase): boolean {
  return countRows(db, `
    select count(*) as count from issues where status=?
      union all
    select count(*) as count from issue_runs where ended_at=''
  `, [STATUS_IN_PROGRESS]) > 0;
}

export function hasTodoIssue(db: RunnerDatabase, projectID: string): boolean {
  const cleanProjectID = projectID.trim();
  if (cleanProjectID === "") return false;
  const sql = "select count(*) as count from issues where project_id=? and status=?";
  return countRows(db, sql, [cleanProjectID, STATUS_TODO]) > 0;
}

function claimNextIssueID(db: RunnerDatabase, projectID: string): number {
  if (hasActiveExecutorWork(db)) return 0;
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

function countRows(db: RunnerDatabase, sql: string, params: string[] = []): number {
  return db.sqlite.query<CountRow, string[]>(sql).all(...params)
    .reduce((sum, row) => sum + row.count, 0);
}
