import type { RunnerDatabase } from "../database.ts";

/**
 * Provider-neutral one-shot project selections (design §13.2). Selecting a
 * project only authorizes the original prompt continuation; nothing persists
 * a conversation "current project". The legacy `feishu_project_selections`
 * table stays as a read-only historical carrier (backfilled by 071/071a).
 */

export type ImProjectSelectionStatus = "pending" | "consumed";

export type ImProjectSelection = {
  candidates: string[];
  candidates_json: string;
  chat_id: string;
  connector_id: string;
  consumed_at: string;
  conversation_id: string;
  created_at: string;
  expires_at: string;
  original_prompt: string;
  scope_key: string;
  selected_project_id: string;
  selection_id: string;
  source_message_id: string;
  status: ImProjectSelectionStatus;
  updated_at: string;
  user_id: string;
  user_open_id: string;
};

export type ImProjectSelectionInput = {
  candidates: string[];
  chatId: string;
  connectorId: string;
  conversationId: string;
  expiresAt: string;
  originalPrompt: string;
  scopeKey: string;
  selectionId: string;
  sourceMessageId: string;
  userId: string;
  userOpenId: string;
};

export type ImProjectSelectionConsumeInput = {
  chatId: string;
  connectorId: string;
  now: Date;
  projectId: string;
  selectionId: string;
  userId: string;
  userOpenId: string;
};

export type ImProjectSelectionConsumeResult = {
  selection: ImProjectSelection | null;
  status: "already_consumed" | "consumed" | "expired" | "invalid_project" | "missing" | "source_mismatch";
};

type SQLValue = number | string;

const COLUMNS = `selection_id, connector_id, scope_key, conversation_id,
  chat_id, user_id, user_open_id, source_message_id, original_prompt,
  candidates_json, status, selected_project_id, expires_at, consumed_at,
  created_at, updated_at`;

export function createImProjectSelection(
  db: RunnerDatabase,
  input: ImProjectSelectionInput,
  timestamp = new Date()
): ImProjectSelection {
  const iso = timestamp.toISOString();
  const candidates = unique(input.candidates.map(cleanString).filter(Boolean));
  if (candidates.length === 0) throw new Error("candidates are required");
  const record: ImProjectSelection = {
    candidates,
    candidates_json: JSON.stringify(candidates),
    chat_id: cleanString(input.chatId),
    connector_id: requireString(input.connectorId, "connector_id"),
    consumed_at: "",
    conversation_id: requireString(input.conversationId, "conversation_id"),
    created_at: iso,
    expires_at: requireString(input.expiresAt, "expires_at"),
    original_prompt: requireString(input.originalPrompt, "original_prompt"),
    scope_key: requireString(input.scopeKey, "scope_key"),
    selected_project_id: "",
    selection_id: requireString(input.selectionId, "selection_id"),
    source_message_id: cleanString(input.sourceMessageId),
    status: "pending",
    updated_at: iso,
    user_id: cleanString(input.userId),
    user_open_id: cleanString(input.userOpenId)
  };
  db.sqlite.run(
    `insert into im_project_selections (${COLUMNS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    insertValues(record)
  );
  const saved = getImProjectSelection(db, record.selection_id);
  if (!saved) throw new Error("im project selection missing after write");
  return saved;
}

export function getImProjectSelection(
  db: RunnerDatabase,
  selectionId: string
): ImProjectSelection | null {
  const id = cleanString(selectionId);
  if (id === "") return null;
  const row = db.sqlite.query<Record<string, unknown>, [string]>(
    `select ${COLUMNS} from im_project_selections where selection_id=?`
  ).get(id);
  return row ? mapSelection(row) : null;
}

export function consumeImProjectSelection(
  db: RunnerDatabase,
  input: ImProjectSelectionConsumeInput
): ImProjectSelectionConsumeResult {
  const write = db.transaction(() => consumeSelection(db, input));
  return write.immediate();
}

function consumeSelection(
  db: RunnerDatabase,
  input: ImProjectSelectionConsumeInput
): ImProjectSelectionConsumeResult {
  const current = getImProjectSelection(db, input.selectionId);
  if (!current) return result("missing", null);
  if (current.connector_id !== cleanString(input.connectorId)) return result("source_mismatch", current);
  if (current.status === "consumed") return result("already_consumed", current);
  if (Date.parse(current.expires_at) <= input.now.getTime()) return result("expired", current);
  if (!sourceMatches(current, input)) return result("source_mismatch", current);
  const projectID = cleanString(input.projectId);
  if (!current.candidates.includes(projectID)) return result("invalid_project", current);
  const iso = input.now.toISOString();
  db.sqlite.run(
    `update im_project_selections set status='consumed', selected_project_id=?, consumed_at=?, updated_at=?
     where selection_id=? and status='pending'`,
    [projectID, iso, iso, current.selection_id]
  );
  return result("consumed", getImProjectSelection(db, current.selection_id));
}

function sourceMatches(current: ImProjectSelection, input: ImProjectSelectionConsumeInput): boolean {
  const chatMatches = current.chat_id === "" || current.chat_id === cleanString(input.chatId);
  const userID = cleanString(input.userId);
  const openID = cleanString(input.userOpenId);
  const userMatches = current.user_id === "" || current.user_id === userID || current.user_id === openID ||
    current.user_open_id === userID || current.user_open_id === openID;
  return chatMatches && userMatches;
}

function insertValues(record: ImProjectSelection): SQLValue[] {
  return [
    record.selection_id, record.connector_id, record.scope_key, record.conversation_id,
    record.chat_id, record.user_id, record.user_open_id, record.source_message_id,
    record.original_prompt, record.candidates_json, record.status,
    record.selected_project_id, record.expires_at, record.consumed_at,
    record.created_at, record.updated_at
  ];
}

function mapSelection(row: Record<string, unknown>): ImProjectSelection {
  const candidatesJson = requireString(row.candidates_json, "candidates_json");
  return {
    candidates: parseCandidates(candidatesJson),
    candidates_json: candidatesJson,
    chat_id: optionalString(row.chat_id),
    connector_id: requireString(row.connector_id, "connector_id"),
    consumed_at: optionalString(row.consumed_at),
    conversation_id: requireString(row.conversation_id, "conversation_id"),
    created_at: requireString(row.created_at, "created_at"),
    expires_at: requireString(row.expires_at, "expires_at"),
    original_prompt: requireString(row.original_prompt, "original_prompt"),
    scope_key: requireString(row.scope_key, "scope_key"),
    selected_project_id: optionalString(row.selected_project_id),
    selection_id: requireString(row.selection_id, "selection_id"),
    source_message_id: optionalString(row.source_message_id),
    status: optionalString(row.status) === "consumed" ? "consumed" : "pending",
    updated_at: requireString(row.updated_at, "updated_at"),
    user_id: optionalString(row.user_id),
    user_open_id: optionalString(row.user_open_id)
  };
}

function result(
  status: ImProjectSelectionConsumeResult["status"],
  selection: ImProjectSelection | null
): ImProjectSelectionConsumeResult {
  return { selection, status };
}

function parseCandidates(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? unique(parsed.map(cleanString).filter(Boolean)) : [];
  } catch {
    return [];
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new Error("expected string row value");
  return value.trim();
}

function requireString(value: unknown, label: string): string {
  const text = cleanString(value);
  if (text === "") throw new Error(`${label} is required`);
  return text;
}
