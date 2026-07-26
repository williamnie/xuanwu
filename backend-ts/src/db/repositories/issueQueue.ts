import type { RunnerDatabase } from "../database.ts";
import { issueTimestamp } from "./issueCreate.ts";
import { createIssueRun } from "./issueRuns.ts";
import { getIssue, type Issue } from "./issues.ts";
import { readProjectIssueDependencies } from "../../domain/work/issueDependency.ts";

const STATUS_TODO = "todo";
const STATUS_IN_PROGRESS = "in_progress";
type ClaimedIssueRow = { id: number };
type CountRow = { count: number };
type ProjectCwdRow = { cwd: string };
export type IssueClaimFilter = (issue: Issue) => boolean;

export function claimNextIssue(
  db: RunnerDatabase,
  projectID: string,
  filter: IssueClaimFilter = () => true,
  at: Date | string = new Date()
): Issue | null {
  const cleanProjectID = projectID.trim();
  if (cleanProjectID === "") throw new Error("project id is required");
  const claim = db.transaction((id: string) => claimNextIssueID(db, id, filter, at));
  const issueID = claim.immediate(cleanProjectID);
  return issueID > 0 ? getIssue(db, issueID) : null;
}

export function hasActiveExecutorWork(db: RunnerDatabase): boolean {
  return countActiveExecutorWork(db) > 0;
}

export function countActiveExecutorWork(db: RunnerDatabase): number {
  return countRows(db, `
    select count(distinct i.id) as count
    from issues i
    left join issue_runs ir on ir.issue_id=i.id and ir.ended_at=''
    where (i.status=? or ir.id is not null)
      and not (
        ir.id is not null and exists (
          select 1 from issue_events event
          where event.issue_id=i.id and event.type='issue.provider_deferred'
            and event.created_at>=ir.started_at
        )
      )
  `, [STATUS_IN_PROGRESS]);
}

export function hasDeferredProviderRuntime(
  db: RunnerDatabase,
  providerID: string,
  at: Date | string = new Date()
): boolean {
  const cleanProviderID = providerID.trim();
  if (cleanProviderID === "") return false;
  return countRows(db, `
    select count(distinct i.id) as count
    from issues i
    where i.status in ('todo', 'in_progress')
      and i.auto_retry_reason=?
      and i.auto_retry_next_at<>''
      and i.auto_retry_next_at>?
  `, [`provider_infra_transient:${cleanProviderID}`, timestamp(at)]) > 0;
}

export function hasActiveExecutorWorkForProject(
  db: RunnerDatabase,
  projectID: string,
  at: Date | string = new Date()
): boolean {
  return countActiveExecutorWorkForProject(db, projectID, at) > 0;
}

export function countActiveExecutorWorkForProject(
  db: RunnerDatabase,
  projectID: string,
  at: Date | string = new Date()
): number {
  const lock = parsedProjectExecutionLockKey(db, projectID);
  const activeAt = timestamp(at);
  if (lock.kind === "cwd") {
    return countRows(db, `
      select count(distinct i.id) as count
      from issues i
      join projects p on p.id=i.project_id
      left join issue_runs ir on ir.issue_id=i.id and ir.ended_at=''
      where trim(p.cwd)=? and (i.status=? or ir.id is not null)
        and not (${expiredProviderDeferralSQL()})
    `, [lock.value, STATUS_IN_PROGRESS, activeAt]);
  }
  return countRows(db, `
    select count(distinct i.id) as count
    from issues i
    left join issue_runs ir on ir.issue_id=i.id and ir.ended_at=''
    where i.project_id=? and (i.status=? or ir.id is not null)
      and not (${expiredProviderDeferralSQL()})
  `, [lock.value, STATUS_IN_PROGRESS, activeAt]);
}

export function hasTodoIssue(db: RunnerDatabase, projectID: string): boolean {
  const cleanProjectID = projectID.trim();
  if (cleanProjectID === "") return false;
  const sql = "select count(*) as count from issues where project_id=? and status=?";
  return countRows(db, sql, [cleanProjectID, STATUS_TODO]) > 0;
}

export function hasReadyIssue(
  db: RunnerDatabase,
  projectID: string,
  filter: IssueClaimFilter = () => true
): boolean {
  const cleanProjectID = projectID.trim();
  if (cleanProjectID === "") return false;
  return nextIssueRow(db, cleanProjectID, filter) !== null;
}

export function peekNextReadyIssue(
  db: RunnerDatabase,
  projectID: string,
  filter: IssueClaimFilter = () => true
): Issue | null {
  const cleanProjectID = projectID.trim();
  if (cleanProjectID === "") return null;
  const row = nextIssueRow(db, cleanProjectID, filter);
  return row ? getIssue(db, row.id) : null;
}

export function peekNextTodoIssue(db: RunnerDatabase, projectID: string): Issue | null {
  const cleanProjectID = projectID.trim();
  if (cleanProjectID === "") return null;
  const row = db.sqlite.query<ClaimedIssueRow, [string, string]>(`
    select id from issues where project_id=? and status=?
    order by priority desc, created_at asc, id asc limit 1
  `).get(cleanProjectID, STATUS_TODO);
  return row ? getIssue(db, row.id) : null;
}

function claimNextIssueID(
  db: RunnerDatabase,
  projectID: string,
  filter: IssueClaimFilter,
  at: Date | string
): number {
  if (hasActiveExecutorWorkForProject(db, projectID, at)) return 0;
  const row = nextIssueRow(db, projectID, filter);
  if (!row) return 0;
  const timestamp = issueTimestamp();
  db.sqlite.run(`update issues set status=?, attempt_count=attempt_count+1,
    auto_retry_next_at='', auto_retry_reason='', error='', updated_at=?
    where id=? and status=?`, [STATUS_IN_PROGRESS, timestamp, row.id, STATUS_TODO]);
  createIssueRun(db, row.id);
  recordClaimEvent(db, row.id, timestamp);
  return row.id;
}

export function projectExecutionLockKey(db: RunnerDatabase, projectID: string): string {
  const cleanProjectID = projectID.trim();
  const cwd = db.sqlite.query<ProjectCwdRow, [string]>(
    "select cwd from projects where id=?"
  ).get(cleanProjectID)?.cwd.trim() ?? "";
  return cwd === "" ? `project:${cleanProjectID}` : `cwd:${cwd}`;
}

function parsedProjectExecutionLockKey(db: RunnerDatabase, projectID: string): { kind: "cwd" | "project"; value: string } {
  const key = projectExecutionLockKey(db, projectID);
  const separator = key.indexOf(":");
  return {
    kind: key.startsWith("cwd:") ? "cwd" : "project",
    value: key.slice(separator + 1)
  };
}

function nextIssueRow(db: RunnerDatabase, projectID: string, filter: IssueClaimFilter): ClaimedIssueRow | null {
  const dependencyByIssueID = readProjectIssueDependencies(db, projectID);
  const rows = db.sqlite.query<ClaimedIssueRow, [string, string]>(`
    select id from issues where project_id=? and status=?
    order by priority desc, created_at asc, id asc
  `).all(projectID, STATUS_TODO);
  return rows.find((row) => {
    if (dependencyByIssueID.get(row.id)?.ready !== true) return false;
    const issue = getIssue(db, row.id);
    return issue !== null && filter(issue);
  }) ?? null;
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

function expiredProviderDeferralSQL(): string {
  return `ir.id is not null and i.auto_retry_next_at<>'' and i.auto_retry_next_at<=? and exists (
    select 1 from issue_events event
    where event.issue_id=i.id and event.type='issue.provider_deferred'
      and event.created_at>=ir.started_at
  )`;
}

function timestamp(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}
