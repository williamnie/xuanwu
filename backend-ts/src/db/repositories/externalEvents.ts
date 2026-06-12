import type { RunnerDatabase } from "../database.ts";

type SQLValue = number | string;
type JsonObject = Record<string, unknown>;
type ExternalEventStoredRecord = Omit<ExternalEventRecord, "id" | "normalized_message" | "summary">;

export type ExternalEventRecord = {
  actor: string;
  content: string;
  dedupe_key: string;
  external_id: string;
  id: number;
  normalized_message: JsonObject;
  normalized_message_json: string;
  project_hint: string;
  project_id: string;
  raw_payload_ref: string;
  received_at: string;
  source: string;
  status: string;
  summary: JsonObject;
  summary_json: string;
  trust_level: string;
};

export type ExternalEventInput = Partial<Omit<ExternalEventRecord, "id">>;

export type ExternalEventListFilter = {
  dedupeKey?: string;
  limit?: number;
  source?: string;
};

const COLUMNS = `id, source, external_id, actor, project_hint, content,
  trust_level, dedupe_key, raw_payload_ref, normalized_message_json,
  project_id, status, summary_json, received_at`;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

export function createExternalEvent(
  db: RunnerDatabase,
  input: ExternalEventInput,
  timestamp = new Date()
): ExternalEventRecord {
  const record = normalizeCreate(input, timestamp);
  db.sqlite.run(`insert into external_events (${insertColumns()}) values (${insertPlaceholders()})`, insertValues(record));
  const saved = getExternalEvent(db, lastInsertID(db));
  if (!saved) throw new Error("external event missing after write");
  return saved;
}

export function upsertExternalEvent(
  db: RunnerDatabase,
  input: ExternalEventInput,
  timestamp = new Date()
): ExternalEventRecord {
  const write = db.transaction(() => {
    const existing = findExternalEventByDedupe(db, input.source, input.dedupe_key);
    return existing ?? createExternalEvent(db, input, timestamp);
  });
  return write.immediate();
}

export function getExternalEvent(db: RunnerDatabase, id: number): ExternalEventRecord | null {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const row = db.sqlite.query<Record<string, unknown>, [number]>(
    `select ${COLUMNS} from external_events where id=?`
  ).get(id);
  return row ? mapExternalEvent(row) : null;
}

export function findExternalEventByDedupe(
  db: RunnerDatabase,
  source: unknown,
  dedupeKey: unknown
): ExternalEventRecord | null {
  const cleanSource = cleanString(source);
  const cleanDedupe = cleanString(dedupeKey);
  if (cleanSource === "" || cleanDedupe === "") return null;
  const row = db.sqlite.query<Record<string, unknown>, [string, string]>(
    `select ${COLUMNS} from external_events where source=? and dedupe_key=? order by received_at desc, id desc limit 1`
  ).get(cleanSource, cleanDedupe);
  return row ? mapExternalEvent(row) : null;
}

export function listExternalEvents(
  db: RunnerDatabase,
  filter: ExternalEventListFilter = {}
): ExternalEventRecord[] {
  const query = listQuery(filter);
  return db.sqlite.query<Record<string, unknown>, SQLValue[]>(
    `select ${COLUMNS} from external_events${query.where} order by received_at desc, id desc limit ?`
  ).all(...query.args).map(mapExternalEvent);
}

function normalizeCreate(input: ExternalEventInput, timestamp: Date): ExternalEventStoredRecord {
  const record = {
    source: cleanString(input.source),
    external_id: cleanString(input.external_id),
    actor: cleanString(input.actor),
    project_hint: cleanString(input.project_hint),
    project_id: cleanString(input.project_id),
    content: cleanString(input.content),
    trust_level: cleanString(input.trust_level) || "untrusted",
    dedupe_key: cleanString(input.dedupe_key),
    raw_payload_ref: cleanString(input.raw_payload_ref),
    normalized_message_json: jsonText(input.normalized_message_json, input.normalized_message),
    received_at: cleanString(input.received_at) || timestamp.toISOString(),
    status: cleanString(input.status) || "inbox",
    summary_json: jsonText(input.summary_json, input.summary)
  };
  requireFields(record, ["source", "content", "dedupe_key"]);
  return record;
}

function listQuery(filter: ExternalEventListFilter): { args: SQLValue[]; where: string } {
  const conditions: string[] = [];
  const args: SQLValue[] = [];
  const source = cleanString(filter.source);
  const dedupeKey = cleanString(filter.dedupeKey);
  if (source !== "") addCondition(conditions, args, "source=?", source);
  if (dedupeKey !== "") addCondition(conditions, args, "dedupe_key=?", dedupeKey);
  args.push(listLimit(filter.limit));
  return { args, where: conditions.length > 0 ? ` where ${conditions.join(" and ")}` : "" };
}

function addCondition(conditions: string[], args: SQLValue[], condition: string, value: string): void {
  conditions.push(condition);
  args.push(value);
}

function listLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(value, MAX_LIST_LIMIT);
}

function mapExternalEvent(row: Record<string, unknown>): ExternalEventRecord {
  return {
    id: integerValue(row.id, "external_events.id"),
    source: requiredString(row.source, "external_events.source"),
    external_id: optionalString(row.external_id),
    actor: optionalString(row.actor),
    project_hint: optionalString(row.project_hint),
    project_id: optionalString(row.project_id),
    content: requiredString(row.content, "external_events.content"),
    trust_level: optionalString(row.trust_level) || "untrusted",
    dedupe_key: requiredString(row.dedupe_key, "external_events.dedupe_key"),
    raw_payload_ref: optionalString(row.raw_payload_ref),
    normalized_message_json: requiredJsonString(row.normalized_message_json),
    normalized_message: jsonObject(row.normalized_message_json),
    status: optionalString(row.status) || "inbox",
    summary_json: requiredJsonString(row.summary_json),
    summary: jsonObject(row.summary_json),
    received_at: requiredString(row.received_at, "external_events.received_at")
  };
}

function requireFields(record: Record<string, string>, fields: string[]): void {
  for (const field of fields) {
    if (record[field] === "") throw new Error(`${field} is required`);
  }
}

function insertColumns(): string {
  return `source, external_id, actor, project_hint, content,
    trust_level, dedupe_key, raw_payload_ref, normalized_message_json,
    project_id, status, summary_json, received_at`;
}

function insertPlaceholders(): string {
  return "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?";
}

function insertValues(record: ExternalEventStoredRecord): SQLValue[] {
  return [
    record.source, record.external_id, record.actor, record.project_hint,
    record.content, record.trust_level, record.dedupe_key, record.raw_payload_ref,
    record.normalized_message_json, record.project_id, record.status,
    record.summary_json, record.received_at
  ];
}

function lastInsertID(db: RunnerDatabase): number {
  return db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new Error("expected string row value");
  return value.trim();
}

function requiredString(value: unknown, label: string): string {
  const text = optionalString(value);
  if (text === "") throw new Error(`${label} is required`);
  return text;
}

function requiredJsonString(value: unknown): string {
  const text = optionalString(value);
  return text === "" ? "{}" : text;
}

function jsonText(primary: unknown, fallback: unknown): string {
  if (typeof primary === "string" && primary.trim() !== "") return primary.trim();
  if (fallback && typeof fallback === "object" && !Array.isArray(fallback)) return JSON.stringify(fallback);
  return "{}";
}

function jsonObject(value: unknown): JsonObject {
  try {
    const parsed = JSON.parse(requiredJsonString(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch {
    return {};
  }
}

function integerValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return value;
}
