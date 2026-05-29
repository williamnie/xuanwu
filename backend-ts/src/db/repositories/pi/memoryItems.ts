import type { RunnerDatabase } from "../../database.ts";
import {
  buildFilter,
  cleanString,
  deleteByID,
  getByID,
  integerInput,
  integerValue,
  listRows,
  now,
  optionalString,
  requiredString,
  requireCreateFields,
  updateByID,
  type PatchInput
} from "./common.ts";

export type PiMemoryItem = {
  id: string; scope: string; scope_id: string; kind: string; content: string;
  source_type: string; source_id: string; confidence: string; pinned: number;
  disabled: number; created_at: string; updated_at: string;
};

export type PiMemoryItemInput = PatchInput<PiMemoryItem>;
export type PiMemoryItemFilter = { disabled?: number; scope?: string; scopeId?: string };

const TABLE = "pi_memory_items";
const COLUMNS = `id, scope, scope_id, kind, content, source_type, source_id,
  confidence, pinned, disabled, created_at, updated_at`;
const UPDATE_COLUMNS = [
  "scope", "scope_id", "kind", "content", "source_type", "source_id",
  "confidence", "pinned", "disabled"
] as const;

export function createPiMemoryItem(db: RunnerDatabase, input: PiMemoryItemInput): PiMemoryItem {
  const record = normalizeCreate(input);
  requireCreateFields(record, ["id", "scope", "kind", "content"]);
  const timestamp = now();
  db.sqlite.run(`insert into ${TABLE} (${COLUMNS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [record.id, record.scope, record.scope_id, record.kind, record.content, record.source_type,
      record.source_id, record.confidence, record.pinned, record.disabled, timestamp, timestamp]);
  return mustGetPiMemoryItem(db, record.id);
}

export function updatePiMemoryItem(db: RunnerDatabase, id: string, input: PiMemoryItemInput): PiMemoryItem {
  updateByID<PiMemoryItem>(db, TABLE, UPDATE_COLUMNS, id, input);
  return mustGetPiMemoryItem(db, id);
}

export function listPiMemoryItems(db: RunnerDatabase, filter: PiMemoryItemFilter = {}): PiMemoryItem[] {
  return listRows(db, TABLE, COLUMNS, mapPiMemoryItem, buildFilter([
    ["scope=?", filter.scope],
    ["scope_id=?", filter.scopeId],
    ["disabled=?", filter.disabled]
  ], "updated_at desc, id asc"));
}

export function getPiMemoryItem(db: RunnerDatabase, id: string): PiMemoryItem | null {
  return getByID(db, TABLE, COLUMNS, id, mapPiMemoryItem);
}

export function deletePiMemoryItem(db: RunnerDatabase, id: string): boolean {
  return deleteByID(db, TABLE, id);
}

function mustGetPiMemoryItem(db: RunnerDatabase, id: string): PiMemoryItem {
  const record = getPiMemoryItem(db, id);
  if (!record) throw new Error("PI memory item missing after write");
  return record;
}

function normalizeCreate(input: PiMemoryItemInput): PiMemoryItem {
  return {
    id: cleanString(input.id), scope: cleanString(input.scope), scope_id: cleanString(input.scope_id),
    kind: cleanString(input.kind), content: cleanString(input.content),
    source_type: cleanString(input.source_type), source_id: cleanString(input.source_id),
    confidence: cleanString(input.confidence) || "medium",
    pinned: integerInput(input.pinned), disabled: integerInput(input.disabled),
    created_at: "", updated_at: ""
  };
}

function mapPiMemoryItem(row: Record<string, unknown>): PiMemoryItem {
  return {
    id: requiredString(row.id, "pi_memory_items.id"),
    scope: requiredString(row.scope, "pi_memory_items.scope"),
    scope_id: optionalString(row.scope_id), kind: requiredString(row.kind, "pi_memory_items.kind"),
    content: requiredString(row.content, "pi_memory_items.content"),
    source_type: optionalString(row.source_type), source_id: optionalString(row.source_id),
    confidence: requiredString(row.confidence, "pi_memory_items.confidence"),
    pinned: integerValue(row.pinned, "pi_memory_items.pinned"),
    disabled: integerValue(row.disabled, "pi_memory_items.disabled"),
    created_at: requiredString(row.created_at, "pi_memory_items.created_at"),
    updated_at: requiredString(row.updated_at, "pi_memory_items.updated_at")
  };
}
