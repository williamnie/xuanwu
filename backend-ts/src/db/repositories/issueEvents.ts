import type { RunnerDatabase } from "../database.ts";
import { cleanString, issueTimestamp } from "./issueCreate.ts";
import { getIssue } from "./issues.ts";
import { ProjectNotFoundError } from "./projects.ts";

export type IssueEvent = {
  created_at: string;
  id: number;
  issue_id: number;
  payload: string;
  type: string;
};

type IssueEventRow = {
  created_at: unknown;
  id: unknown;
  issue_id: unknown;
  payload: unknown;
  type: unknown;
};

type CreateIssueCommentInput = {
  author?: unknown;
  body?: unknown;
};

export function listIssueEvents(db: RunnerDatabase, issueID: number): IssueEvent[] {
  ensureIssueExists(db, issueID);
  return db.sqlite.query<IssueEventRow, [number]>(`
    select id, issue_id, type, payload, created_at from issue_events
    where issue_id = ? order by created_at asc, id asc
  `).all(issueID).map(mapIssueEventRow);
}

export function createIssueComment(db: RunnerDatabase, issueID: number, input: CreateIssueCommentInput): IssueEvent {
  ensureIssueExists(db, issueID);
  const body = cleanString(input.body);
  if (body === "") throw new Error("评论内容不能为空");
  const author = normalizeCommentAuthor(input.author);
  const timestamp = issueTimestamp();
  const payload = JSON.stringify({ author, body });
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [issueID, "issue.comment", payload, timestamp]
  );
  return mustGetIssueEvent(db, lastInsertID(db));
}

function normalizeCommentAuthor(value: unknown): string {
  const author = cleanString(value) || "user";
  if (author === "user" || author === "agent" || author === "system") return author;
  throw new Error("评论作者必须是 user、agent 或 system");
}

function ensureIssueExists(db: RunnerDatabase, id: number): void {
  if (!getIssue(db, id)) throw new ProjectNotFoundError();
}

function mustGetIssueEvent(db: RunnerDatabase, id: number): IssueEvent {
  const row = db.sqlite.query<IssueEventRow, [number]>(`
    select id, issue_id, type, payload, created_at from issue_events where id = ?
  `).get(id);
  if (!row) throw new Error("created issue event missing");
  return mapIssueEventRow(row);
}

function mapIssueEventRow(row: IssueEventRow): IssueEvent {
  return {
    id: positiveInteger(row.id, "issue_events.id"),
    issue_id: positiveInteger(row.issue_id, "issue_events.issue_id"),
    type: requiredString(row.type, "issue_events.type"),
    payload: optionalString(row.payload),
    created_at: requiredString(row.created_at, "issue_events.created_at")
  };
}

function lastInsertID(db: RunnerDatabase): number {
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (typeof row?.id !== "number" || !Number.isInteger(row.id) || row.id <= 0) {
    throw new Error("inserted issue event id must be positive");
  }
  return row.id;
}

function requiredString(value: unknown, label: string): string {
  const text = optionalString(value);
  if (text === "") throw new Error(`${label} is required`);
  return text;
}

function optionalString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new Error("expected string row value");
  return value.trim();
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be positive`);
  }
  return value;
}
