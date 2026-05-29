import type { RunnerDatabase } from "../../database.ts";
import {
  buildFilter,
  cleanString,
  deleteByID,
  getByID,
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

const TABLE = "pi_conversations";
const COLUMNS = `id, project_id, pi_agent_id, title, status, session_file,
  pi_session_id, created_at, updated_at`;
const UPDATE_COLUMNS = ["project_id", "pi_agent_id", "title", "status", "session_file", "pi_session_id"] as const;

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

export function getPiConversation(db: RunnerDatabase, id: string): PiConversation | null {
  return getByID(db, TABLE, COLUMNS, id, mapPiConversation);
}

export function deletePiConversation(db: RunnerDatabase, id: string): boolean {
  return deleteByID(db, TABLE, id);
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
