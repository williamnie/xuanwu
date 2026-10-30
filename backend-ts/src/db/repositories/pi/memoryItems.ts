import type { RunnerDatabase } from "../../database.ts";
import {
  assertAutomaticMemoryCorrection,
  assertMemoryRevision,
  clearMemorySuppression,
  memorySuppression,
  memoryWriteIdentity,
  PiMemoryWriteError,
  recordMemoryHistory,
  recordMemoryReceipt,
  suppressMemory,
  type PiMemoryWriteOptions
} from "./memoryHistory.ts";
import {
  buildFilter,
  cleanString,
  deleteByID,
  getByID,
  hasPatchValue,
  integerInput,
  listRows,
  now,
  requireCreateFields,
  updateByID,
  type PatchInput
} from "./common.ts";
import {
  PI_MEMORY_TYPES,
  PI_MEMORY_LAYERS,
  PI_MEMORY_AUTHORITIES,
  normalizeCreate,
  normalizeUpdate,
  mapPiMemoryItem
} from "./memoryItemsModel.ts";

export { listPiMemoryHistory } from "./memoryHistory.ts";

export type PiMemoryItem = {
  // content 兼容旧纯文本及 memoryExperience.ts 的 v1 JSON；repository 不赋予语义权威。
  id: string; scope: string; scope_id: string; kind: string; content: string;
  source_type: string; source_id: string; confidence: string; pinned: number;
  disabled: number; memory_type: PiMemoryType; layer: PiMemoryLayer;
  authority: PiMemoryAuthority; authorized_by: string; authorized_at: string;
  memory_key: string; occurrence_count: number; last_seen_at: string;
  citation_type: string; citation_id: string; citation_label: string; citation_url: string;
  revision: number; created_at: string; updated_at: string;
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

export type PiMemoryAuthority = (typeof PI_MEMORY_AUTHORITIES)[number];

const TABLE = "pi_memory_items";

const COLUMNS = `id, scope, scope_id, kind, content, source_type, source_id,
  confidence, pinned, disabled, memory_type, layer, citation_type, citation_id,
  citation_label, citation_url, authority, authorized_by, authorized_at,
  memory_key, occurrence_count, last_seen_at, created_at, updated_at, revision`;

const UPDATE_COLUMNS = [
  "scope", "scope_id", "kind", "content", "source_type", "source_id",
  "confidence", "pinned", "disabled", "memory_type", "layer", "citation_type",
  "citation_id", "citation_label", "citation_url", "authority", "authorized_by", "authorized_at",
  "memory_key", "occurrence_count", "last_seen_at"
] as const;

export function createPiMemoryItem(db: RunnerDatabase, input: PiMemoryItemInput): PiMemoryItem {
  return db.transaction(() => createMemory(db, input)).immediate();
}

function createMemory(db: RunnerDatabase, input: PiMemoryItemInput): PiMemoryItem {
  const record = normalizeCreate(input);
  if (memorySuppression(db, record.scope, record.scope_id, record.memory_key)) {
    throw new PiMemoryWriteError("memory is suppressed; explicit user re-enable required");
  }
  requireCreateFields(record, ["id", "scope", "kind", "content"]);
  const timestamp = now();
  const revision = db.sqlite.query<{ revision: number }, [string]>(
    "select coalesce(max(revision), 0) + 1 as revision from pi_memory_history where memory_id=?"
  ).get(record.id)!.revision;
  db.sqlite.run(`insert into ${TABLE} (${COLUMNS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [record.id, record.scope, record.scope_id, record.kind, record.content, record.source_type,
      record.source_id, record.confidence, record.pinned, record.disabled, record.memory_type,
      record.layer, record.citation_type, record.citation_id, record.citation_label,
      record.citation_url, record.authority, record.authorized_by, record.authorized_at,
      record.memory_key, record.occurrence_count,
      record.last_seen_at || timestamp, timestamp, timestamp, revision]);
  const item = mustGetPiMemoryItem(db, record.id);
  recordMemoryHistory(db, item, "create");
  recordMemoryReceipt(db, item);
  if (item.disabled) suppressMemory(db, item, "disabled");
  return item;
}

export function rememberPiMemoryItem(
  db: RunnerDatabase, input: PiMemoryItemInput, options: PiMemoryWriteOptions = {}
): PiMemoryItem {
  const scope = cleanString(input.scope);
  const scopeID = cleanString(input.scope_id);
  const memoryKey = cleanString(input.memory_key);
  requireCreateFields({ scope, memory_key: memoryKey }, ["scope", "memory_key"]);
  return db.transaction(() => {
    const current = getPiMemoryItemByKey(db, scope, scopeID, memoryKey);
    const suppressed = memorySuppression(db, scope, scopeID, memoryKey);
    // reenable 是可信调用方确认的独立用户操作，不能从普通自动写入的 disabled=0 推导。
    if ((current?.disabled || suppressed) && !options.reenable) {
      throw new PiMemoryWriteError("memory is disabled or forgotten; explicit user re-enable required");
    }
    if (input.authority === "evidence_backed" && options.reenable) {
      throw new PiMemoryWriteError("automatic experience cannot re-enable memory");
    }
    if (!current) {
      if (options.correction || options.expectedRevision !== undefined) throw new PiMemoryWriteError("memory to correct is missing");
      if (options.reenable) clearMemorySuppression(db, { scope, scope_id: scopeID, memory_key: memoryKey });
      return createMemory(db, { ...input, disabled: 0, occurrence_count: 1 });
    }
    if (input.authority === "evidence_backed" && (current.authority === "user_explicit" ||
      ["user_preference", "project_preference", "preference", "constraint"].includes(current.kind))) {
      throw new PiMemoryWriteError("automatic experience cannot overwrite explicit user memory");
    }
    const next = { ...current, ...normalizeUpdate(input), id: current.id } as PiMemoryItem;
    // 兼容迁移前记录，第一次写入时补当前来源收据，不增加出现次数。
    recordMemoryReceipt(db, current);
    const identity = memoryWriteIdentity(next);
    const replay = db.sqlite.query<{ revision: number }, [string, string, string]>(
      "select revision from pi_memory_receipts where memory_id=? and source_key=? and content_hash=?"
    ).get(current.id, identity.source, identity.content);
    const explicitUserAdoption = next.authority === "user_explicit" && current.authority !== "user_explicit";
    if (replay && !explicitUserAdoption && !options.reenable && options.expectedRevision === undefined) return current;
    assertMemoryRevision(current, options.correction?.expected_revision ?? options.expectedRevision);
    assertAutomaticMemoryCorrection(current, next, options);
    const knownSource = db.sqlite.query<{ present: number }, [string, string]>(
      "select 1 as present from pi_memory_receipts where memory_id=? and source_key=? limit 1"
    ).get(current.id, identity.source);
    const item = writeMemoryUpdate(db, current, {
      ...input, disabled: options.correction?.disposition === "disable" ? 1 : 0,
      last_seen_at: now(), occurrence_count: current.occurrence_count + (knownSource ? 0 : 1)
    }, options.correction ? "correct" : options.reenable ? "enable" : "remember", options);
    recordMemoryReceipt(db, item);
    return item;
  }).immediate();
}

export function updatePiMemoryItem(
  db: RunnerDatabase, id: string, input: PiMemoryItemInput, options: PiMemoryWriteOptions = {}
): PiMemoryItem {
  return db.transaction(() => {
    const current = mustGetPiMemoryItem(db, id);
    assertMemoryRevision(current, options.expectedRevision);
    const operation = hasPatchValue(input, "disabled")
      ? integerInput(input.disabled) ? "disable" : "enable" : "edit";
    return writeMemoryUpdate(db, current, input, operation, options);
  }).immediate();
}

function writeMemoryUpdate(
  db: RunnerDatabase, current: PiMemoryItem, input: PiMemoryItemInput, operation: string, options: PiMemoryWriteOptions
): PiMemoryItem {
  for (const field of ["scope", "scope_id", "memory_key"] as const) {
    if (hasPatchValue(input, field) && cleanString(input[field]) !== current[field]) {
      throw new PiMemoryWriteError("memory identity is stable; forget and create a new key to move memory");
    }
  }
  const patch = normalizeUpdate(input);
  // 调用方不能伪造版本与计数；remember 的去重逻辑独占出现次数。
  if (operation === "edit" || operation === "enable" || operation === "disable") delete patch.occurrence_count;
  const changed = UPDATE_COLUMNS.some((key) => hasPatchValue(patch, key) && patch[key] !== current[key]);
  if (!changed) return current;
  updateByID<PiMemoryItem>(db, TABLE, UPDATE_COLUMNS, current.id, patch);
  db.sqlite.run("update pi_memory_items set revision=revision+1 where id=?", [current.id]);
  const item = mustGetPiMemoryItem(db, current.id);
  if (item.disabled) suppressMemory(db, item, "disabled");
  else clearMemorySuppression(db, item);
  recordMemoryHistory(db, item, operation, options.correction);
  return item;
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
  return db.transaction(() => {
    const current = getPiMemoryItem(db, id);
    if (!current) return false;
    suppressMemory(db, current, "forgotten");
    recordMemoryHistory(db, { ...current, revision: current.revision + 1, updated_at: now() }, "forget");
    // 遗忘后仅保留版本/操作/来源归属，不让历史接口变成被遗忘内容的旁路。
    db.sqlite.run(`update pi_memory_history set snapshot_json=json_object(
      'id', memory_id, 'revision', revision, 'source_type', json_extract(snapshot_json, '$.source_type'),
      'source_id', json_extract(snapshot_json, '$.source_id')), correction_json='{}' where memory_id=?`, [id]);
    db.sqlite.run("delete from pi_memory_receipts where memory_id=?", [id]);
    return deleteByID(db, TABLE, id);
  }).immediate();
}

function mustGetPiMemoryItem(db: RunnerDatabase, id: string): PiMemoryItem {
  const record = getPiMemoryItem(db, id);
  if (!record) throw new Error("PI memory item missing after write");
  return record;
}
