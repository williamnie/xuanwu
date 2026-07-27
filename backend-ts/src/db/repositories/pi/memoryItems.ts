import type { RunnerDatabase } from "../../database.ts";
import {
  buildFilter,
  cleanString,
  deleteByID,
  getByID,
  hasPatchValue,
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
  disabled: number; memory_type: PiMemoryType; layer: PiMemoryLayer;
  memory_key: string; occurrence_count: number; last_seen_at: string;
  citation_type: string; citation_id: string; citation_label: string; citation_url: string;
  created_at: string; updated_at: string;
};

export type PiMemoryItemInput = PatchInput<PiMemoryItem>;
export type PiMemoryItemFilter = {
  disabled?: number;
  layer?: PiMemoryLayer | string;
  memoryType?: PiMemoryType | string;
  scope?: string;
  scopeId?: string;
};
export type PiMemoryType = (typeof PI_MEMORY_TYPES)[number];
export type PiMemoryLayer = (typeof PI_MEMORY_LAYERS)[number];

export const PI_MEMORY_TYPES = ["user", "project", "inbox", "source", "skill"] as const;
export const PI_MEMORY_LAYERS = ["ephemeral", "working", "long_term"] as const;

const TABLE = "pi_memory_items";
const COLUMNS = `id, scope, scope_id, kind, content, source_type, source_id,
  confidence, pinned, disabled, memory_type, layer, citation_type, citation_id,
  citation_label, citation_url, memory_key, occurrence_count, last_seen_at, created_at, updated_at`;
const UPDATE_COLUMNS = [
  "scope", "scope_id", "kind", "content", "source_type", "source_id",
  "confidence", "pinned", "disabled", "memory_type", "layer", "citation_type",
  "citation_id", "citation_label", "citation_url", "memory_key", "occurrence_count", "last_seen_at"
] as const;

export function createPiMemoryItem(db: RunnerDatabase, input: PiMemoryItemInput): PiMemoryItem {
  const record = normalizeCreate(input);
  requireCreateFields(record, ["id", "scope", "kind", "content"]);
  const timestamp = now();
  db.sqlite.run(`insert into ${TABLE} (${COLUMNS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [record.id, record.scope, record.scope_id, record.kind, record.content, record.source_type,
      record.source_id, record.confidence, record.pinned, record.disabled, record.memory_type,
      record.layer, record.citation_type, record.citation_id, record.citation_label,
      record.citation_url, record.memory_key, record.occurrence_count,
      record.last_seen_at || timestamp, timestamp, timestamp]);
  return mustGetPiMemoryItem(db, record.id);
}

export function rememberPiMemoryItem(db: RunnerDatabase, input: PiMemoryItemInput): PiMemoryItem {
  const scope = cleanString(input.scope);
  const scopeID = cleanString(input.scope_id);
  const memoryKey = cleanString(input.memory_key);
  requireCreateFields({ scope, memory_key: memoryKey }, ["scope", "memory_key"]);
  const write = db.transaction((record: PiMemoryItemInput) => {
    const current = getPiMemoryItemByKey(db, scope, scopeID, memoryKey);
    if (!current) return createPiMemoryItem(db, {
      ...record,
      disabled: 0,
      last_seen_at: now(),
      memory_key: memoryKey,
      occurrence_count: 1
    });
    return updatePiMemoryItem(db, current.id, {
      ...record,
      disabled: 0,
      last_seen_at: now(),
      memory_key: memoryKey,
      occurrence_count: current.occurrence_count + 1
    });
  });
  return write.immediate(input);
}

export function updatePiMemoryItem(db: RunnerDatabase, id: string, input: PiMemoryItemInput): PiMemoryItem {
  updateByID<PiMemoryItem>(db, TABLE, UPDATE_COLUMNS, id, normalizeUpdate(input));
  return mustGetPiMemoryItem(db, id);
}

export function listPiMemoryItems(db: RunnerDatabase, filter: PiMemoryItemFilter = {}): PiMemoryItem[] {
  return listRows(db, TABLE, COLUMNS, mapPiMemoryItem, buildFilter([
    ["scope=?", filter.scope],
    ["scope_id=?", filter.scopeId],
    ["disabled=?", filter.disabled],
    ["memory_type=?", filter.memoryType],
    ["layer=?", filter.layer]
  ], "updated_at desc, id asc"));
}

export function getPiMemoryItem(db: RunnerDatabase, id: string): PiMemoryItem | null {
  return getByID(db, TABLE, COLUMNS, id, mapPiMemoryItem);
}

export function getPiMemoryItemByKey(
  db: RunnerDatabase,
  scope: string,
  scopeID: string,
  memoryKey: string
): PiMemoryItem | null {
  const row = db.sqlite.query<Record<string, unknown>, [string, string, string]>(
    `select ${COLUMNS} from ${TABLE} where scope=? and scope_id=? and memory_key=? limit 1`
  ).get(cleanString(scope), cleanString(scopeID), cleanString(memoryKey));
  return row ? mapPiMemoryItem(row) : null;
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
  const scope = cleanString(input.scope);
  return {
    id: cleanString(input.id), scope, scope_id: cleanString(input.scope_id),
    kind: cleanString(input.kind), content: cleanString(input.content),
    source_type: cleanString(input.source_type), source_id: cleanString(input.source_id),
    confidence: cleanString(input.confidence) || "medium",
    pinned: integerInput(input.pinned), disabled: integerInput(input.disabled),
    memory_type: normalizeMemoryType(input.memory_type, memoryTypeForScope(scope)),
    layer: normalizeMemoryLayer(input.layer),
    citation_type: cleanString(input.citation_type),
    citation_id: cleanString(input.citation_id),
    citation_label: cleanString(input.citation_label),
    citation_url: cleanString(input.citation_url),
    memory_key: cleanString(input.memory_key) || cleanString(input.id),
    occurrence_count: positiveInteger(input.occurrence_count, 1),
    last_seen_at: cleanString(input.last_seen_at),
    created_at: "", updated_at: ""
  };
}

function normalizeUpdate(input: PiMemoryItemInput): PiMemoryItemInput {
  const output = { ...input };
  if (hasPatchValue(input, "memory_type")) output.memory_type = normalizeMemoryType(input.memory_type, "user");
  if (hasPatchValue(input, "layer")) output.layer = normalizeMemoryLayer(input.layer);
  for (const field of ["citation_type", "citation_id", "citation_label", "citation_url"] as const) {
    if (hasPatchValue(input, field)) output[field] = cleanString(input[field]);
  }
  if (hasPatchValue(input, "memory_key")) output.memory_key = cleanString(input.memory_key);
  if (hasPatchValue(input, "occurrence_count")) output.occurrence_count = positiveInteger(input.occurrence_count, 1);
  if (hasPatchValue(input, "last_seen_at")) output.last_seen_at = cleanString(input.last_seen_at);
  return output;
}

function mapPiMemoryItem(row: Record<string, unknown>): PiMemoryItem {
  const id = requiredString(row.id, "pi_memory_items.id");
  const updatedAt = requiredString(row.updated_at, "pi_memory_items.updated_at");
  return {
    id,
    scope: requiredString(row.scope, "pi_memory_items.scope"),
    scope_id: optionalString(row.scope_id), kind: requiredString(row.kind, "pi_memory_items.kind"),
    content: requiredString(row.content, "pi_memory_items.content"),
    source_type: optionalString(row.source_type), source_id: optionalString(row.source_id),
    confidence: requiredString(row.confidence, "pi_memory_items.confidence"),
    pinned: integerValue(row.pinned, "pi_memory_items.pinned"),
    disabled: integerValue(row.disabled, "pi_memory_items.disabled"),
    memory_type: normalizeMemoryType(row.memory_type, "user"),
    layer: normalizeMemoryLayer(row.layer),
    citation_type: optionalString(row.citation_type),
    citation_id: optionalString(row.citation_id),
    citation_label: optionalString(row.citation_label),
    citation_url: optionalString(row.citation_url),
    memory_key: optionalString(row.memory_key) || id,
    occurrence_count: integerValue(row.occurrence_count, "pi_memory_items.occurrence_count"),
    last_seen_at: optionalString(row.last_seen_at) || updatedAt,
    created_at: requiredString(row.created_at, "pi_memory_items.created_at"),
    updated_at: updatedAt
  };
}

function normalizeMemoryType(value: unknown, fallback: PiMemoryType): PiMemoryType {
  const text = cleanString(value);
  if (text === "") return fallback;
  if (isMemoryType(text)) return text;
  throw new Error(`memory_type must be one of ${PI_MEMORY_TYPES.join(", ")}`);
}

function normalizeMemoryLayer(value: unknown): PiMemoryLayer {
  const text = cleanString(value);
  if (text === "") return "working";
  if (isMemoryLayer(text)) return text;
  throw new Error(`layer must be one of ${PI_MEMORY_LAYERS.join(", ")}`);
}

function isMemoryType(value: string): value is PiMemoryType {
  return (PI_MEMORY_TYPES as readonly string[]).includes(value);
}

function isMemoryLayer(value: string): value is PiMemoryLayer {
  return (PI_MEMORY_LAYERS as readonly string[]).includes(value);
}

function memoryTypeForScope(scope: string): PiMemoryType {
  if (scope === "project") return "project";
  if (scope === "inbox") return "inbox";
  if (scope === "source") return "source";
  if (scope === "skill") return "skill";
  return "user";
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
