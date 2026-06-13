import type { RunnerDatabase } from "../database.ts";

export type FeishuProjectSelectionStatus = "pending" | "consumed";
export type FeishuPendingProjectSelection = {
  candidates: string[];
  candidates_json: string;
  chat_id: string;
  consumed_at: string;
  conversation_id: string;
  created_at: string;
  expires_at: string;
  original_prompt: string;
  scope_key: string;
  selected_project_id: string;
  selection_id: string;
  source_message_id: string;
  status: FeishuProjectSelectionStatus;
  user_id: string;
  user_open_id: string;
};
export type FeishuPendingProjectSelectionInput = {
  candidates: string[];
  chatId: string;
  conversationId: string;
  expiresAt: string;
  originalPrompt: string;
  scopeKey: string;
  selectionId: string;
  sourceMessageId: string;
  userId: string;
  userOpenId: string;
};
export type FeishuProjectSelectionConsumeInput = {
  chatId: string;
  now: Date;
  projectId: string;
  selectionId: string;
  userId: string;
  userOpenId: string;
};
export type FeishuProjectSelectionConsumeResult = {
  selection: FeishuPendingProjectSelection | null;
  status: "already_consumed" | "consumed" | "expired" | "invalid_project" | "missing" | "source_mismatch";
};

type SQLValue = number | string;

const COLUMNS = `selection_id, scope_key, conversation_id, chat_id, user_id,
  user_open_id, source_message_id, original_prompt, candidates_json, status,
  selected_project_id, created_at, expires_at, consumed_at`;

export function createFeishuPendingProjectSelection(
  db: RunnerDatabase,
  input: FeishuPendingProjectSelectionInput,
  timestamp = new Date()
): FeishuPendingProjectSelection {
  const record = normalizeCreate(input, timestamp);
  db.sqlite.run(
    `insert into feishu_project_selections (${COLUMNS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    insertValues(record)
  );
  const saved = getFeishuPendingProjectSelection(db, record.selection_id);
  if (!saved) throw new Error("Feishu project selection missing after write");
  return saved;
}

export function getFeishuPendingProjectSelection(
  db: RunnerDatabase,
  selectionId: string
): FeishuPendingProjectSelection | null {
  const id = cleanString(selectionId);
  if (id === "") return null;
  const row = db.sqlite.query<Record<string, unknown>, [string]>(
    `select ${COLUMNS} from feishu_project_selections where selection_id=?`
  ).get(id);
  return row ? mapSelection(row) : null;
}

export function consumeFeishuPendingProjectSelection(
  db: RunnerDatabase,
  input: FeishuProjectSelectionConsumeInput
): FeishuProjectSelectionConsumeResult {
  const write = db.transaction(() => consumeSelection(db, input));
  return write.immediate();
}

function consumeSelection(
  db: RunnerDatabase,
  input: FeishuProjectSelectionConsumeInput
): FeishuProjectSelectionConsumeResult {
  const current = getFeishuPendingProjectSelection(db, input.selectionId);
  if (!current) return result("missing", null);
  if (current.status === "consumed") return result("already_consumed", current);
  if (Date.parse(current.expires_at) <= input.now.getTime()) return result("expired", current);
  if (!sourceMatches(current, input)) return result("source_mismatch", current);
  const projectID = cleanString(input.projectId);
  if (!current.candidates.includes(projectID)) return result("invalid_project", current);
  db.sqlite.run(
    `update feishu_project_selections set status='consumed', selected_project_id=?, consumed_at=? where selection_id=? and status='pending'`,
    [projectID, input.now.toISOString(), current.selection_id]
  );
  return result("consumed", getFeishuPendingProjectSelection(db, current.selection_id));
}

function sourceMatches(
  current: FeishuPendingProjectSelection,
  input: FeishuProjectSelectionConsumeInput
): boolean {
  const chatMatches = current.chat_id === "" || current.chat_id === cleanString(input.chatId);
  const userID = cleanString(input.userId);
  const openID = cleanString(input.userOpenId);
  const userMatches = current.user_id === "" || current.user_id === userID || current.user_id === openID ||
    current.user_open_id === userID || current.user_open_id === openID;
  return chatMatches && userMatches;
}

function normalizeCreate(
  input: FeishuPendingProjectSelectionInput,
  timestamp: Date
): FeishuPendingProjectSelection {
  const candidates = unique(input.candidates.map(cleanString).filter(Boolean));
  const record = {
    candidates,
    candidates_json: JSON.stringify(candidates),
    chat_id: cleanString(input.chatId),
    consumed_at: "",
    conversation_id: requireString(input.conversationId, "conversation_id"),
    created_at: timestamp.toISOString(),
    expires_at: requireString(input.expiresAt, "expires_at"),
    original_prompt: requireString(input.originalPrompt, "original_prompt"),
    scope_key: requireString(input.scopeKey, "scope_key"),
    selected_project_id: "",
    selection_id: requireString(input.selectionId, "selection_id"),
    source_message_id: cleanString(input.sourceMessageId),
    status: "pending" as const,
    user_id: cleanString(input.userId),
    user_open_id: cleanString(input.userOpenId)
  };
  if (record.candidates.length === 0) throw new Error("candidates are required");
  return record;
}

function insertValues(record: FeishuPendingProjectSelection): SQLValue[] {
  return [
    record.selection_id, record.scope_key, record.conversation_id, record.chat_id,
    record.user_id, record.user_open_id, record.source_message_id,
    record.original_prompt, record.candidates_json, record.status,
    record.selected_project_id, record.created_at, record.expires_at, record.consumed_at
  ];
}

function mapSelection(row: Record<string, unknown>): FeishuPendingProjectSelection {
  const candidatesJson = requireString(row.candidates_json, "candidates_json");
  return {
    candidates: parseCandidates(candidatesJson),
    candidates_json: candidatesJson,
    chat_id: optionalString(row.chat_id),
    consumed_at: optionalString(row.consumed_at),
    conversation_id: requireString(row.conversation_id, "conversation_id"),
    created_at: requireString(row.created_at, "created_at"),
    expires_at: requireString(row.expires_at, "expires_at"),
    original_prompt: requireString(row.original_prompt, "original_prompt"),
    scope_key: requireString(row.scope_key, "scope_key"),
    selected_project_id: optionalString(row.selected_project_id),
    selection_id: requireString(row.selection_id, "selection_id"),
    source_message_id: optionalString(row.source_message_id),
    status: selectionStatus(row.status),
    user_id: optionalString(row.user_id),
    user_open_id: optionalString(row.user_open_id)
  };
}

function result(
  status: FeishuProjectSelectionConsumeResult["status"],
  selection: FeishuPendingProjectSelection | null
): FeishuProjectSelectionConsumeResult {
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

function selectionStatus(value: unknown): FeishuProjectSelectionStatus {
  return cleanString(value) === "consumed" ? "consumed" : "pending";
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
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") throw new Error(`${label} is required`);
  return text;
}
