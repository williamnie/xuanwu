import type { RunnerDatabase } from "../database.ts";
import { cleanString } from "../../util/values.ts";
import {
  type IssueFilter,
  ISSUE_COLUMNS,
  normalizeSourceSessionID,
  type Issue,
  type IssueRun,
  type IssueRunRow,
  ISSUE_RUN_COLUMNS,
  mapIssueRunRow
} from "./issuesModel.ts";

export function buildIssueListQuery(filter: IssueFilter): { args: Array<number | string>; sql: string } {
  const query = buildIssueWhere(filter);
  const pagination = issuePagination(filter);
  return {
    args: [...query.args, ...pagination.args],
    sql: `select ${ISSUE_COLUMNS} from issues${query.where}${issueOrder(filter)}${pagination.sql}`
  };
}

export function buildIssueWhere(filter: IssueFilter): { args: Array<number | string>; where: string } {
  const conditions: string[] = [];
  const args: Array<number | string> = [];
  const projectId = cleanString(filter.projectId);
  const status = cleanString(filter.status);
  const statuses = uniqueStrings([status, ...(filter.statuses ?? [])]);
  const query = cleanString(filter.query);
  const sourceSessionId = normalizeSourceSessionID(filter.sourceSessionId);
  addFilter(conditions, args, "project_id = ?", projectId);
  if (statuses.length > 0) {
    conditions.push(`status in (${statuses.map(() => "?").join(", ")})`);
    args.push(...statuses);
  }
  if (query) {
    conditions.push("instr(lower(title || char(10) || description), lower(?)) > 0");
    args.push(query);
  }
  addFilter(conditions, args, "source_session_id = ?", sourceSessionId);
  if (filter.source) {
    // The case points at its current task; external_links retains every earlier round.
    // Pin the issue lookup: the covering identity index otherwise scans all GitHub links per row.
    const githubSource = `(exists (
      select 1 from github_issue_cases gc where gc.issue_id = issues.id
    ) or exists (
      select 1 from external_links el indexed by idx_external_links_issue
      join github_issue_cases gc on gc.issue_node_id = el.external_id
      where el.issue_id = issues.id and el.source = 'github' and el.external_type = 'github_issue'
    ))`;
    conditions.push(filter.source === "github" ? githubSource : `not ${githubSource}`);
  }
  if (filter.cursorUpdatedAt !== undefined || filter.cursorIssueId !== undefined) {
    const cursorUpdatedAt = cleanString(filter.cursorUpdatedAt);
    const cursorIssueID = filter.cursorIssueId;
    if (!cursorUpdatedAt || !Number.isSafeInteger(cursorIssueID) || Number(cursorIssueID) <= 0) {
      throw new Error("issue list cursor is invalid");
    }
    conditions.push("(updated_at < ? or (updated_at = ? and id < ?))");
    args.push(cursorUpdatedAt, cursorUpdatedAt, Number(cursorIssueID));
  }
  return {
    args,
    where: conditions.length > 0 ? ` where ${conditions.join(" and ")}` : ""
  };
}

function addFilter(conditions: string[], args: Array<number | string>, condition: string, value: string): void {
  if (!value) return;
  conditions.push(condition);
  args.push(value);
}

function issueOrder(filter: IssueFilter): string {
  const direction = filter.sortOrder === "asc" ? "asc" : "desc";
  if (filter.sort === "created_at") return ` order by created_at ${direction}, id ${direction}`;
  if (filter.sort === "updated_at") return ` order by updated_at ${direction}, id ${direction}`;
  if (filter.sort === "title") return ` order by title collate nocase ${direction}, id ${direction}`;
  if (filter.sort === "status") return ` order by status ${direction}, id ${direction}`;
  return " order by priority desc, created_at asc";
}

function issuePagination(filter: IssueFilter): { args: number[]; sql: string } {
  if (filter.limit === undefined && filter.offset === undefined) return { args: [], sql: "" };
  const limit = nonNegativeInteger(filter.limit, "issue list limit", true);
  const offset = nonNegativeInteger(filter.offset ?? 0, "issue list offset", false);
  return { args: [limit, offset], sql: " limit ? offset ?" };
}

function nonNegativeInteger(value: number | undefined, field: string, positive: boolean): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map(cleanString).filter(Boolean))];
}

export function attachLatestRuns(db: RunnerDatabase, issues: Issue[]): Issue[] {
  if (issues.length === 0) return issues;
  const latestRuns = loadLatestRuns(db, issues.map((issue) => issue.id));
  return issues.map((issue) => {
    const latest_run = latestRuns.get(issue.id);
    return latest_run ? { ...issue, latest_run } : issue;
  });
}

function loadLatestRuns(db: RunnerDatabase, issueIDs: number[]): Map<number, IssueRun> {
  const placeholders = issueIDs.map(() => "?").join(", ");
  const rows = db.sqlite.query<IssueRunRow, number[]>(`
    select ${ISSUE_RUN_COLUMNS} from issue_runs ir
    join (
      select issue_id, max(attempt) as attempt from issue_runs
      where issue_id in (${placeholders}) group by issue_id
    ) latest on latest.issue_id=ir.issue_id and latest.attempt=ir.attempt
  `).all(...issueIDs);
  return new Map(rows.map((row) => {
    const run = mapIssueRunRow(row);
    return [run.issue_id, run];
  }));
}
