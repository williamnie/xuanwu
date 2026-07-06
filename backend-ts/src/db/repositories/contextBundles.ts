import type { RunnerDatabase } from "../database.ts";

type SQLValue = number | string;
type JsonObject = Record<string, unknown>;

export type ContextBundleTrigger =
  | "manual"
  | "mention"
  | "schedule"
  | "continuous"
  | "webhook"
  | "retry";

export type ContextBundleCreatedBy = "user" | "automation" | "system";
export type ContextBundleWindow = { from: string; to: string };
export type ContextBundleSourceQuery = JsonObject;

export type ContextBundleEvidenceSummary = {
  actor: string;
  attachment_refs: string[];
  event_ref: number;
  occurred_at: string;
  source_ref: string;
  summary: string;
};

export type ContextBundleInput = {
  attachment_refs?: string[];
  context?: ContextBundleEvidenceSummary[];
  created_by: ContextBundleCreatedBy;
  event_refs: number[];
  evidence_refs?: string[];
  reason: string;
  source: string;
  source_query?: ContextBundleSourceQuery;
  token_budget?: number;
  trigger: ContextBundleTrigger;
  window: ContextBundleWindow;
};

export type ContextBundleRecord = Required<ContextBundleInput> & {
  attachment_refs_json: string;
  created_at: string;
  event_refs_json: string;
  evidence_refs_json: string;
  id: number;
  source_query_json: string;
  summary_json: string;
  window_json: string;
};

const COLUMNS = `id, source, event_refs_json, attachment_refs_json,
  window_json, reason, trigger, created_by, source_query_json,
  evidence_refs_json, token_budget, summary_json, created_at`;

export function createContextBundle(
  db: RunnerDatabase,
  input: ContextBundleInput,
  timestamp = new Date()
): ContextBundleRecord {
  const record = normalizeCreate(input, timestamp);
  db.sqlite.run(`insert into context_bundles (${insertColumns()})
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, insertValues(record));
  const saved = getContextBundle(db, lastInsertID(db));
  if (!saved) throw new Error("context bundle missing after write");
  return saved;
}

export function getContextBundle(db: RunnerDatabase, id: number): ContextBundleRecord | null {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const row = db.sqlite.query<Record<string, unknown>, [number]>(
    `select ${COLUMNS} from context_bundles where id=?`
  ).get(id);
  return row ? mapContextBundle(row) : null;
}

export function listContextBundles(db: RunnerDatabase, source = "", limit = 100): ContextBundleRecord[] {
  const args = listArgs(source, limit);
  const where = source.trim() === "" ? "" : " where source=?";
  return db.sqlite.query<Record<string, unknown>, SQLValue[]>(
    `select ${COLUMNS} from context_bundles${where} order by created_at desc, id desc limit ?`
  ).all(...args).map(mapContextBundle);
}

function normalizeCreate(input: ContextBundleInput, timestamp: Date): ContextBundleRecord {
  const source = cleanString(input.source);
  const eventRefs = uniquePositiveIntegers(input.event_refs);
  const attachmentRefs = uniqueStrings(input.attachment_refs);
  const evidenceRefs = uniqueStrings(input.evidence_refs);
  const context = Array.isArray(input.context) ? input.context : [];
  requireSourceAndRefs(source, eventRefs);
  return {
    id: 0,
    source,
    event_refs: eventRefs,
    attachment_refs: attachmentRefs,
    window: normalizeWindow(input.window),
    reason: cleanString(input.reason) || "context_bundle",
    trigger: normalizeTrigger(input.trigger),
    created_by: normalizeCreatedBy(input.created_by),
    source_query: objectValue(input.source_query),
    evidence_refs: evidenceRefs.length > 0 ? evidenceRefs : defaultEvidenceRefs(eventRefs, attachmentRefs),
    token_budget: positiveInteger(input.token_budget),
    context,
    event_refs_json: JSON.stringify(eventRefs),
    attachment_refs_json: JSON.stringify(attachmentRefs),
    window_json: JSON.stringify(normalizeWindow(input.window)),
    source_query_json: JSON.stringify(objectValue(input.source_query)),
    evidence_refs_json: JSON.stringify(evidenceRefs.length > 0 ? evidenceRefs : defaultEvidenceRefs(eventRefs, attachmentRefs)),
    summary_json: JSON.stringify({ context }),
    created_at: timestamp.toISOString()
  };
}

function mapContextBundle(row: Record<string, unknown>): ContextBundleRecord {
  const summary = jsonObject(row.summary_json);
  return {
    id: integerValue(row.id, "context_bundles.id"),
    source: requiredString(row.source, "context_bundles.source"),
    event_refs: numberArray(row.event_refs_json),
    attachment_refs: stringArray(row.attachment_refs_json),
    window: windowValue(row.window_json),
    reason: requiredString(row.reason, "context_bundles.reason"),
    trigger: normalizeTrigger(row.trigger),
    created_by: normalizeCreatedBy(row.created_by),
    source_query: jsonObject(row.source_query_json),
    evidence_refs: stringArray(row.evidence_refs_json),
    token_budget: integerValue(row.token_budget, "context_bundles.token_budget"),
    context: contextArray(summary.context),
    event_refs_json: requiredJsonString(row.event_refs_json, "[]"),
    attachment_refs_json: requiredJsonString(row.attachment_refs_json, "[]"),
    window_json: requiredJsonString(row.window_json, "{}"),
    source_query_json: requiredJsonString(row.source_query_json, "{}"),
    evidence_refs_json: requiredJsonString(row.evidence_refs_json, "[]"),
    summary_json: requiredJsonString(row.summary_json, "{}"),
    created_at: requiredString(row.created_at, "context_bundles.created_at")
  };
}

function insertColumns(): string {
  return `source, event_refs_json, attachment_refs_json, window_json,
    reason, trigger, created_by, source_query_json, evidence_refs_json,
    token_budget, summary_json, created_at`;
}

function insertValues(record: ContextBundleRecord): SQLValue[] {
  return [
    record.source, record.event_refs_json, record.attachment_refs_json,
    record.window_json, record.reason, record.trigger, record.created_by,
    record.source_query_json, record.evidence_refs_json, record.token_budget,
    record.summary_json, record.created_at
  ];
}

function listArgs(source: string, limit: number): SQLValue[] {
  const cleanSource = source.trim();
  const cleanLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
  return cleanSource === "" ? [cleanLimit] : [cleanSource, cleanLimit];
}

function requireSourceAndRefs(source: string, eventRefs: number[]): void {
  if (source === "") throw new Error("source is required");
  if (eventRefs.length === 0) throw new Error("event_refs is required");
}

function defaultEvidenceRefs(eventRefs: number[], attachmentRefs: string[]): string[] {
  return [...eventRefs.map((id) => `external_event:${id}`), ...attachmentRefs];
}

function normalizeWindow(value: unknown): ContextBundleWindow {
  const item = objectValue(value);
  return { from: cleanString(item.from), to: cleanString(item.to) };
}

function windowValue(value: unknown): ContextBundleWindow {
  return normalizeWindow(jsonObject(value));
}

function normalizeTrigger(value: unknown): ContextBundleTrigger {
  const text = cleanString(value);
  const allowed = ["manual", "mention", "schedule", "continuous", "webhook", "retry"];
  return allowed.includes(text) ? text as ContextBundleTrigger : "continuous";
}

function normalizeCreatedBy(value: unknown): ContextBundleCreatedBy {
  const text = cleanString(value);
  const allowed = ["user", "automation", "system"];
  return allowed.includes(text) ? text as ContextBundleCreatedBy : "system";
}

function uniquePositiveIntegers(value: unknown): number[] {
  const items = Array.isArray(value) ? value : [];
  return [...new Set(items.filter((item) => Number.isSafeInteger(item) && item > 0))] as number[];
}

function uniqueStrings(value: unknown): string[] {
  const items = Array.isArray(value) ? value.map(cleanString).filter(Boolean) : [];
  return [...new Set(items)];
}

function contextArray(value: unknown): ContextBundleEvidenceSummary[] {
  return Array.isArray(value) ? value.map(contextItem).filter((item) => item.event_ref > 0) : [];
}

function contextItem(value: unknown): ContextBundleEvidenceSummary {
  const item = objectValue(value);
  return {
    actor: cleanString(item.actor),
    attachment_refs: uniqueStrings(item.attachment_refs),
    event_ref: positiveInteger(item.event_ref),
    occurred_at: cleanString(item.occurred_at),
    source_ref: cleanString(item.source_ref),
    summary: cleanString(item.summary)
  };
}

function numberArray(value: unknown): number[] {
  try {
    return uniquePositiveIntegers(JSON.parse(requiredJsonString(value, "[]")));
  } catch {
    return [];
  }
}

function stringArray(value: unknown): string[] {
  try {
    return uniqueStrings(JSON.parse(requiredJsonString(value, "[]")));
  } catch {
    return [];
  }
}

function jsonObject(value: unknown): JsonObject {
  try {
    const parsed = JSON.parse(requiredJsonString(value, "{}"));
    return objectValue(parsed);
  } catch {
    return {};
  }
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function requiredJsonString(value: unknown, fallback: string): string {
  const text = cleanString(value);
  return text === "" ? fallback : text;
}

function requiredString(value: unknown, label: string): string {
  const text = cleanString(value);
  if (text === "") throw new Error(`${label} is required`);
  return text;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function integerValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return value;
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function lastInsertID(db: RunnerDatabase): number {
  return db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0;
}
