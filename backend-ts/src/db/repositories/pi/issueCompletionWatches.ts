import type { RunnerDatabase } from "../../database.ts";
import { getIssue, type Issue } from "../issues.ts";
import {
  cleanString,
  integerInput,
  integerValue,
  now,
  optionalString,
  requiredString
} from "./common.ts";

export type PiIssueCompletionWatchStatus = "active" | "satisfied" | "notified" | "cancelled" | "failed";
export type PiIssueCompletionWatch = {
  completed_at: string; condition: string; created_at: string; error: string; id: string;
  idempotency_key: string; items: PiIssueCompletionWatchItem[]; notified_at: string;
  origin_conversation_id: string; project_id: string; requested_by: string;
  source_event_id: string; source_message_id: string; status: PiIssueCompletionWatchStatus;
  target_channel: string; target_chat_id: string; target_message_id: string;
  target_thread_id: string; updated_at: string;
};
export type PiIssueCompletionWatchItem = {
  created_at: string; initial_status: string; issue_id: number; last_status: string;
  project_id: string; terminal_at: string; updated_at: string; watch_id: string;
};
export type PiIssueCompletionWatchInput = {
  condition?: unknown; id?: unknown; issue_ids?: unknown; origin_conversation_id?: unknown;
  project_id?: unknown; requested_by?: unknown; source_event_id?: unknown;
  source_message_id?: unknown; target_channel?: unknown; target_chat_id?: unknown;
  target_message_id?: unknown; target_thread_id?: unknown;
};

const WATCH_TABLE = "pi_issue_completion_watches";
const ITEM_TABLE = "pi_issue_completion_watch_items";
const WATCH_COLUMNS = `id, idempotency_key, project_id, origin_conversation_id,
  source_event_id, source_message_id, target_channel, target_chat_id,
  target_thread_id, target_message_id, requested_by, condition, status,
  created_at, updated_at, completed_at, notified_at, error`;
const ITEM_COLUMNS = `watch_id, issue_id, project_id, initial_status, last_status,
  terminal_at, created_at, updated_at`;
export const ISSUE_COMPLETION_TERMINAL_STATUSES = new Set([
  "done", "failed", "cancelled", "pending_verification"
]);
const DEFAULT_CONDITION = JSON.stringify({
  pending_verification_satisfies: true,
  terminal_statuses: [...ISSUE_COMPLETION_TERMINAL_STATUSES],
  type: "all_terminal"
});

export function createPiIssueCompletionWatch(
  db: RunnerDatabase,
  input: PiIssueCompletionWatchInput
): PiIssueCompletionWatch {
  const record = normalizeCreate(db, input);
  const write = db.transaction(() => {
    const existing = findActiveWatchByKey(db, record.header.idempotency_key);
    if (existing) return existing;
    db.sqlite.run(`insert into ${WATCH_TABLE} (${WATCH_COLUMNS}) values (${placeholders(18)})`, [
      record.header.id, record.header.idempotency_key, record.header.project_id,
      record.header.origin_conversation_id, record.header.source_event_id,
      record.header.source_message_id, record.header.target_channel, record.header.target_chat_id,
      record.header.target_thread_id, record.header.target_message_id, record.header.requested_by,
      record.header.condition, record.header.status, record.header.created_at, record.header.updated_at,
      record.header.completed_at, record.header.notified_at, record.header.error
    ]);
    for (const item of record.items) insertWatchItem(db, item);
    refreshWatchIfSatisfied(db, record.header.id, record.header.created_at);
    return requirePiIssueCompletionWatch(db, record.header.id);
  });
  return write.immediate();
}

export function getPiIssueCompletionWatch(db: RunnerDatabase, id: string): PiIssueCompletionWatch | null {
  const key = cleanString(id);
  if (key === "") return null;
  const row = db.sqlite.query<Record<string, unknown>, [string]>(
    `select ${WATCH_COLUMNS} from ${WATCH_TABLE} where id=?`
  ).get(key);
  return row ? withItems(db, mapWatch(row)) : null;
}

export function listActivePiIssueCompletionWatches(db: RunnerDatabase): PiIssueCompletionWatch[] {
  return db.sqlite.query<Record<string, unknown>, []>(
    `select ${WATCH_COLUMNS} from ${WATCH_TABLE} where status='active' order by created_at asc, id asc`
  ).all().map(mapWatch).map((watch) => withItems(db, watch));
}

export function updatePiIssueCompletionWatchItemStatus(
  db: RunnerDatabase,
  watchID: string,
  issueID: number,
  lastStatus: string
): PiIssueCompletionWatchItem {
  const timestamp = now();
  const key = cleanString(watchID);
  const status = requiredString(lastStatus, "last_status");
  const current = requireWatchItem(db, key, issueID);
  const terminalAt = terminalStatus(status) ? current.terminal_at || timestamp : "";
  db.sqlite.run(`update ${ITEM_TABLE} set last_status=?, terminal_at=?, updated_at=?
    where watch_id=? and issue_id=?`, [status, terminalAt, timestamp, key, current.issue_id]);
  refreshWatchIfSatisfied(db, key, timestamp);
  return requireWatchItem(db, key, current.issue_id);
}

export function markPiIssueCompletionWatchSatisfied(
  db: RunnerDatabase,
  id: string,
  error: string = ""
): PiIssueCompletionWatch {
  const watch = requirePiIssueCompletionWatch(db, id);
  if (!["active", "satisfied"].includes(watch.status)) return watch;
  const timestamp = now();
  db.sqlite.run(`update ${WATCH_TABLE} set status='satisfied',
    completed_at=case when completed_at='' then ? else completed_at end,
    error=?, updated_at=? where id=?`, [timestamp, cleanString(error), timestamp, watch.id]);
  return requirePiIssueCompletionWatch(db, watch.id);
}

export function markPiIssueCompletionWatchNotified(db: RunnerDatabase, id: string): PiIssueCompletionWatch {
  const watch = requirePiIssueCompletionWatch(db, id);
  if (watch.status === "notified") return watch;
  const timestamp = now();
  db.sqlite.run(`update ${WATCH_TABLE} set status='notified',
    completed_at=case when completed_at='' then ? else completed_at end,
    notified_at=case when notified_at='' then ? else notified_at end,
    updated_at=? where id=?`, [timestamp, timestamp, timestamp, watch.id]);
  return requirePiIssueCompletionWatch(db, watch.id);
}

export function cancelPiIssueCompletionWatch(
  db: RunnerDatabase,
  id: string,
  error: string = ""
): PiIssueCompletionWatch {
  const watch = requirePiIssueCompletionWatch(db, id);
  if (watch.status !== "active") return watch;
  const timestamp = now();
  db.sqlite.run(`update ${WATCH_TABLE} set status='cancelled', error=?, updated_at=? where id=?`, [
    cleanString(error), timestamp, watch.id
  ]);
  return requirePiIssueCompletionWatch(db, watch.id);
}

function normalizeCreate(db: RunnerDatabase, input: PiIssueCompletionWatchInput) {
  const issues = loadIssues(db, normalizeIssueIDs(input.issue_ids));
  const timestamp = now();
  const projectID = watchProjectID(issues, input.project_id);
  const issueIDs = issues.map((issue) => issue.id);
  const header = {
    completed_at: "", condition: conditionText(input.condition), created_at: timestamp,
    error: "", id: cleanString(input.id) || crypto.randomUUID(),
    idempotency_key: "", items: [], notified_at: "",
    origin_conversation_id: cleanString(input.origin_conversation_id), project_id: projectID,
    requested_by: cleanString(input.requested_by), source_event_id: cleanString(input.source_event_id),
    source_message_id: cleanString(input.source_message_id), status: "active" as const,
    target_channel: cleanString(input.target_channel), target_chat_id: cleanString(input.target_chat_id),
    target_message_id: cleanString(input.target_message_id), target_thread_id: cleanString(input.target_thread_id),
    updated_at: timestamp
  };
  header.idempotency_key = idempotencyKey(header, issueIDs);
  return { header, items: issues.map((issue) => itemSnapshot(header.id, issue, timestamp)) };
}

function loadIssues(db: RunnerDatabase, issueIDs: number[]): Issue[] {
  if (issueIDs.length === 0) throw new Error("issue_ids is required");
  return issueIDs.map((id) => {
    const issue = getIssue(db, id);
    if (!issue) throw new Error(`issue ${id} not found`);
    return issue;
  });
}

function normalizeIssueIDs(value: unknown): number[] {
  const raw = Array.isArray(value) ? value : [value];
  return [...new Set(raw.map((item) => integerInput(item)).filter((item) => item > 0))].sort((a, b) => a - b);
}

function watchProjectID(issues: Issue[], value: unknown): string {
  const projectID = cleanString(value) || issues[0]?.project_id || "";
  if (projectID === "") throw new Error("project_id is required");
  if (issues.some((issue) => issue.project_id !== projectID)) throw new Error("issue project_id does not match watch");
  return projectID;
}

function itemSnapshot(watchID: string, issue: Issue, timestamp: string): PiIssueCompletionWatchItem {
  return {
    created_at: timestamp, initial_status: issue.status, issue_id: issue.id,
    last_status: issue.status, project_id: issue.project_id,
    terminal_at: terminalStatus(issue.status) ? timestamp : "", updated_at: timestamp, watch_id: watchID
  };
}

function insertWatchItem(db: RunnerDatabase, item: PiIssueCompletionWatchItem): void {
  db.sqlite.run(`insert into ${ITEM_TABLE} (${ITEM_COLUMNS}) values (${placeholders(8)})`, [
    item.watch_id, item.issue_id, item.project_id, item.initial_status, item.last_status,
    item.terminal_at, item.created_at, item.updated_at
  ]);
}

function refreshWatchIfSatisfied(db: RunnerDatabase, watchID: string, timestamp: string): void {
  const watch = getPiIssueCompletionWatch(db, watchID);
  if (!watch || watch.status !== "active") return;
  if (watch.items.length === 0 || watch.items.some((item) => !terminalStatus(item.last_status))) return;
  db.sqlite.run(`update ${WATCH_TABLE} set status='satisfied',
    completed_at=case when completed_at='' then ? else completed_at end,
    updated_at=? where id=? and status='active'`, [timestamp, timestamp, watch.id]);
}

function findActiveWatchByKey(db: RunnerDatabase, key: string): PiIssueCompletionWatch | null {
  const row = db.sqlite.query<Record<string, unknown>, [string]>(
    `select ${WATCH_COLUMNS} from ${WATCH_TABLE} where idempotency_key=? and status='active'
     order by created_at asc, id asc limit 1`
  ).get(key);
  return row ? withItems(db, mapWatch(row)) : null;
}

function withItems(db: RunnerDatabase, watch: Omit<PiIssueCompletionWatch, "items">): PiIssueCompletionWatch {
  const items = db.sqlite.query<Record<string, unknown>, [string]>(
    `select ${ITEM_COLUMNS} from ${ITEM_TABLE} where watch_id=? order by issue_id asc`
  ).all(watch.id).map(mapItem);
  return { ...watch, items };
}

function requirePiIssueCompletionWatch(db: RunnerDatabase, id: string): PiIssueCompletionWatch {
  const watch = getPiIssueCompletionWatch(db, id);
  if (!watch) throw new Error(`PI issue completion watch ${cleanString(id)} not found`);
  return watch;
}

function requireWatchItem(db: RunnerDatabase, watchID: string, issueID: number): PiIssueCompletionWatchItem {
  const row = db.sqlite.query<Record<string, unknown>, [string, number]>(
    `select ${ITEM_COLUMNS} from ${ITEM_TABLE} where watch_id=? and issue_id=?`
  ).get(watchID, issueID);
  if (!row) throw new Error(`PI issue completion watch item ${watchID}:${issueID} not found`);
  return mapItem(row);
}

function mapWatch(row: Record<string, unknown>): Omit<PiIssueCompletionWatch, "items"> {
  return {
    completed_at: optionalString(row.completed_at), condition: optionalString(row.condition) || "{}",
    created_at: requiredString(row.created_at, `${WATCH_TABLE}.created_at`),
    error: optionalString(row.error), id: requiredString(row.id, `${WATCH_TABLE}.id`),
    idempotency_key: requiredString(row.idempotency_key, `${WATCH_TABLE}.idempotency_key`),
    notified_at: optionalString(row.notified_at), origin_conversation_id: optionalString(row.origin_conversation_id),
    project_id: requiredString(row.project_id, `${WATCH_TABLE}.project_id`), requested_by: optionalString(row.requested_by),
    source_event_id: optionalString(row.source_event_id), source_message_id: optionalString(row.source_message_id),
    status: watchStatus(row.status), target_channel: optionalString(row.target_channel),
    target_chat_id: optionalString(row.target_chat_id), target_message_id: optionalString(row.target_message_id),
    target_thread_id: optionalString(row.target_thread_id), updated_at: requiredString(row.updated_at, `${WATCH_TABLE}.updated_at`)
  };
}

function mapItem(row: Record<string, unknown>): PiIssueCompletionWatchItem {
  return {
    created_at: requiredString(row.created_at, `${ITEM_TABLE}.created_at`),
    initial_status: optionalString(row.initial_status), issue_id: integerValue(row.issue_id, `${ITEM_TABLE}.issue_id`),
    last_status: optionalString(row.last_status), project_id: requiredString(row.project_id, `${ITEM_TABLE}.project_id`),
    terminal_at: optionalString(row.terminal_at), updated_at: requiredString(row.updated_at, `${ITEM_TABLE}.updated_at`),
    watch_id: requiredString(row.watch_id, `${ITEM_TABLE}.watch_id`)
  };
}

function idempotencyKey(record: Omit<PiIssueCompletionWatch, "items">, issueIDs: number[]): string {
  return ["issue_completion_watch", record.project_id, record.source_event_id, record.source_message_id,
    record.target_channel, record.target_chat_id, record.target_thread_id,
    record.target_message_id, issueIDs.join(",")].join(":");
}

function conditionText(value: unknown): string {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (value && typeof value === "object" && !Array.isArray(value)) return JSON.stringify(value);
  return DEFAULT_CONDITION;
}

function terminalStatus(status: string): boolean {
  return ISSUE_COMPLETION_TERMINAL_STATUSES.has(cleanString(status));
}

function watchStatus(value: unknown): PiIssueCompletionWatchStatus {
  const status = optionalString(value) as PiIssueCompletionWatchStatus;
  return ["active", "satisfied", "notified", "cancelled", "failed"].includes(status) ? status : "active";
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
