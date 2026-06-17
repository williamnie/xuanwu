import type { RunnerDatabase } from "../../database.ts";
import {
  buildFilter,
  cleanString,
  deleteByID,
  getByID,
  integerInput,
  listRows,
  now,
  optionalString,
  requiredString,
  requireCreateFields,
  updateByID,
  type PatchInput
} from "./common.ts";

export type PiConversation = {
  id: string; project_id: string; pi_agent_id: string; title: string; status: string;
  session_file: string; pi_session_id: string; created_at: string; updated_at: string;
};

export type PiConversationInput = PatchInput<PiConversation>;
export type PiConversationFilter = { piAgentId?: string; projectId?: string; status?: string };
export type ArchivedPiConversationListInput = { cursor?: string; pageSize?: number; projectId?: string };
export type ArchivedPiConversationListItem = {
  archived_at: string;
  id: string;
  pi_session_id: string;
  project_id: string | null;
  project_name: string;
  project_title: string;
  session_id: string;
  title: string;
};
export type ArchivedPiConversationPage = {
  items: ArchivedPiConversationListItem[];
  next_cursor: string | null;
  next_page_token: string | null;
  total: number;
};

const TABLE = "pi_conversations";
const COLUMNS = `id, project_id, pi_agent_id, title, status, session_file,
  pi_session_id, created_at, updated_at`;
const UPDATE_COLUMNS = ["project_id", "pi_agent_id", "title", "status", "session_file", "pi_session_id"] as const;
const ARCHIVED_STATUS = "archived";
const DEFAULT_ARCHIVED_PAGE_SIZE = 20;
const MAX_ARCHIVED_PAGE_SIZE = 50;

export function createPiConversation(db: RunnerDatabase, input: PiConversationInput): PiConversation {
  const record = normalizeCreate(input);
  requireCreateFields(record, ["id", "pi_agent_id"]);
  const timestamp = now();
  db.sqlite.run(`insert into ${TABLE} (${COLUMNS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [record.id, record.project_id, record.pi_agent_id, record.title, record.status,
      record.session_file, record.pi_session_id, timestamp, timestamp]);
  return mustGetPiConversation(db, record.id);
}

export function updatePiConversation(
  db: RunnerDatabase,
  id: string,
  input: PiConversationInput
): PiConversation {
  updateByID<PiConversation>(db, TABLE, UPDATE_COLUMNS, id, input);
  return mustGetPiConversation(db, id);
}

export function listPiConversations(
  db: RunnerDatabase,
  filter: PiConversationFilter = {}
): PiConversation[] {
  return listRows(db, TABLE, COLUMNS, mapPiConversation, buildFilter([
    ["project_id=?", filter.projectId],
    ["pi_agent_id=?", filter.piAgentId],
    ["status=?", filter.status]
  ], "updated_at desc, id asc"));
}

export function listArchivedPiConversations(
  db: RunnerDatabase,
  input: ArchivedPiConversationListInput = {}
): ArchivedPiConversationPage {
  const pageSize = archivedPageSize(input.pageSize);
  const rows = archivedConversationRows(db, input, pageSize + 1);
  const pageRows = rows.slice(0, pageSize);
  const nextCursor = rows.length > pageSize ? archiveCursor(pageRows.at(-1)) : null;
  return {
    items: pageRows.map(archivedListItem),
    next_cursor: nextCursor,
    next_page_token: nextCursor,
    total: archivedConversationTotal(db, input.projectId)
  };
}

export function getPiConversation(db: RunnerDatabase, id: string): PiConversation | null {
  return getByID(db, TABLE, COLUMNS, id, mapPiConversation);
}

export function deletePiConversation(db: RunnerDatabase, id: string): boolean {
  return deleteByID(db, TABLE, id);
}

export function restorePiConversation(db: RunnerDatabase, id: string): PiConversation {
  return updatePiConversation(db, id, { status: "active" });
}

function mustGetPiConversation(db: RunnerDatabase, id: string): PiConversation {
  const record = getPiConversation(db, id);
  if (!record) throw new Error("PI conversation missing after write");
  return record;
}

function normalizeCreate(input: PiConversationInput): PiConversation {
  return {
    id: cleanString(input.id), project_id: cleanString(input.project_id),
    pi_agent_id: cleanString(input.pi_agent_id), title: cleanString(input.title),
    status: cleanString(input.status) || "active", session_file: cleanString(input.session_file),
    pi_session_id: cleanString(input.pi_session_id), created_at: "", updated_at: ""
  };
}

function mapPiConversation(row: Record<string, unknown>): PiConversation {
  return {
    id: requiredString(row.id, "pi_conversations.id"),
    project_id: optionalString(row.project_id),
    pi_agent_id: requiredString(row.pi_agent_id, "pi_conversations.pi_agent_id"),
    title: optionalString(row.title), status: requiredString(row.status, "pi_conversations.status"),
    session_file: optionalString(row.session_file), pi_session_id: optionalString(row.pi_session_id),
    created_at: requiredString(row.created_at, "pi_conversations.created_at"),
    updated_at: requiredString(row.updated_at, "pi_conversations.updated_at")
  };
}

function archivedConversationRows(
  db: RunnerDatabase,
  input: ArchivedPiConversationListInput,
  limit: number
): PiConversation[] {
  const where = archivedWhere(input);
  return db.sqlite.query<Record<string, unknown>, Array<number | string>>(
    `select ${COLUMNS} from ${TABLE}${where.sql} order by updated_at desc, id asc limit ?`
  ).all(...where.args, limit).map(mapPiConversation);
}

function archivedWhere(input: ArchivedPiConversationListInput): { args: string[]; sql: string } {
  const conditions = ["status=?"];
  const args = [ARCHIVED_STATUS];
  const projectID = cleanString(input.projectId);
  const cursor = parseArchiveCursor(input.cursor);
  if (projectID !== "") {
    conditions.push("project_id=?");
    args.push(projectID);
  }
  if (cursor) {
    conditions.push("(updated_at < ? or (updated_at = ? and id > ?))");
    args.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
  }
  return { args, sql: ` where ${conditions.join(" and ")}` };
}

function archivedConversationTotal(db: RunnerDatabase, projectId: unknown): number {
  const projectID = cleanString(projectId);
  const sql = projectID === ""
    ? `select count(*) as count from ${TABLE} where status=?`
    : `select count(*) as count from ${TABLE} where status=? and project_id=?`;
  const args = projectID === "" ? [ARCHIVED_STATUS] : [ARCHIVED_STATUS, projectID];
  const row = db.sqlite.query<{ count: number }, string[]>(sql).get(...args);
  return row?.count ?? 0;
}

function archivedListItem(conversation: PiConversation): ArchivedPiConversationListItem {
  return {
    archived_at: conversation.updated_at,
    id: conversation.id,
    pi_session_id: conversation.pi_session_id,
    project_id: conversation.project_id || null,
    project_name: conversation.project_id,
    project_title: conversation.project_id,
    session_id: conversation.id,
    title: conversation.title || "Untitled Chat"
  };
}

function archiveCursor(conversation: PiConversation | undefined): string | null {
  return conversation ? `${conversation.updated_at}|${conversation.id}` : null;
}

function parseArchiveCursor(cursor: unknown): { id: string; updatedAt: string } | null {
  const text = cleanString(cursor);
  const separator = text.indexOf("|");
  if (separator <= 0 || separator >= text.length - 1) return null;
  return { updatedAt: text.slice(0, separator), id: text.slice(separator + 1) };
}

function archivedPageSize(value: unknown): number {
  const size = integerInput(value, DEFAULT_ARCHIVED_PAGE_SIZE);
  if (size < 1) return DEFAULT_ARCHIVED_PAGE_SIZE;
  return Math.min(size, MAX_ARCHIVED_PAGE_SIZE);
}
