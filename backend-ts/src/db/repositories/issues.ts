import type { RunnerDatabase } from "../database.ts";
import {
  type IssueFilter,
  type Issue,
  type IssueRow,
  mapIssueRow,
  ISSUE_COLUMNS,
  positiveInteger,
  type IssueRun,
  type IssueRunRow,
  ISSUE_RUN_COLUMNS,
  mapIssueRunRow
} from "./issuesModel.ts";
import { buildIssueListQuery, attachLatestRuns, buildIssueWhere } from "./issuesQueries.ts";

export function listIssues(db: RunnerDatabase, filter: IssueFilter = {}): Issue[] {
  const query = buildIssueListQuery(filter);
  const rows = db.sqlite.query<IssueRow, Array<number | string>>(query.sql).all(...query.args);
  return attachLatestRuns(db, rows.map(mapIssueRow));
}

export function countIssues(db: RunnerDatabase, filter: IssueFilter = {}): number {
  const query = buildIssueWhere(filter);
  return db.sqlite.query<{ count: number }, Array<number | string>>(
    `select count(*) as count from issues${query.where}`
  ).get(...query.args)?.count ?? 0;
}

/** Batch read of existing Issue records; no run hydration or writes. */
export function getIssuesByIDs(db: RunnerDatabase, ids: number[]): Issue[] {
  if (ids.length === 0) return [];
  return db.sqlite.query<IssueRow, number[]>(`select ${ISSUE_COLUMNS} from issues where id in (${ids.map(() => "?").join(",")})`)
    .all(...ids).map(mapIssueRow);
}

export function getIssue(db: RunnerDatabase, id: number): Issue | null {
  const issueID = positiveInteger(id, "issue id");
  const row = db.sqlite.query<IssueRow, [number]>(`
    select ${ISSUE_COLUMNS} from issues where id = ?
  `).get(issueID);
  if (!row) return null;
  return mapIssueRow(row);
}

export function listIssueRuns(db: RunnerDatabase, id: number): IssueRun[] {
  const issueID = positiveInteger(id, "issue id");
  return db.sqlite.query<IssueRunRow, [number]>(`
    select ${ISSUE_RUN_COLUMNS} from issue_runs ir
    where ir.issue_id = ? order by ir.attempt asc
  `).all(issueID).map(mapIssueRunRow);
}

export type { IssueFilter } from "./issuesModel.ts";
export type { IssueRun } from "./issuesModel.ts";
export type { Issue } from "./issuesModel.ts";
