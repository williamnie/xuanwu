import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../../database.ts";
import {
  buildFilter,
  cleanString,
  integerInput,
  integerValue,
  jsonText,
  listRows,
  now,
  optionalString,
  requiredString,
  type PatchInput
} from "./common.ts";

export type PiGuardianEvent = {
  consumed_at: string; conversation_id: string; created_at: string; error: string;
  event_type: string; id: string; idempotency_key: string; issue_id: number;
  lease_expires_at: string; lease_owner: string; normalized_payload_json: string;
  project_id: string; redaction_profile: string; run_group_id: string;
  sequence_id: number; severity: string; source: string; source_event_id: string;
  source_sequence: number; status: string; updated_at: string;
};
export type PiGuardianEventInput = PatchInput<PiGuardianEvent>;
export type PiGuardianEventFilter = {
  issueId?: number; projectId?: string; runGroupId?: string; source?: string; status?: string;
};

type SQLValue = string | number;
const TABLE = "pi_guardian_event_inbox";
const KEY_PART_LIMIT = 64;
const MINUTE_MS = 60_000;
const COLUMNS = `sequence_id, id, source, source_event_id, source_sequence, event_type,
  project_id, issue_id, run_group_id, conversation_id, severity, normalized_payload_json,
  redaction_profile, status, lease_owner, lease_expires_at, consumed_at, idempotency_key,
  error, created_at, updated_at`;
const UPDATE_COLUMNS = [
  "status", "lease_owner", "lease_expires_at", "consumed_at", "error",
  "severity", "normalized_payload_json", "redaction_profile"
] as const;

export function createPiGuardianEvent(db: RunnerDatabase, input: PiGuardianEventInput): PiGuardianEvent {
  const record = normalizeCreate(input);
  const existing = findExistingEvent(db, record);
  if (existing) return existing;
  const timestamp = record.created_at || now();
  const updatedAt = now();
  db.sqlite.run(`insert or ignore into ${TABLE} (${insertColumns()}) values (${placeholders(20)})`, [
    record.id, record.source, record.source_event_id, record.source_sequence,
    record.event_type, record.project_id, record.issue_id, record.run_group_id,
    record.conversation_id, record.severity, record.normalized_payload_json,
    record.redaction_profile, record.status, record.lease_owner, record.lease_expires_at,
    record.consumed_at, record.idempotency_key, record.error, timestamp, updatedAt
  ]);
  return mustGetPiGuardianEvent(db, record);
}

export function getPiGuardianEvent(db: RunnerDatabase, id: string): PiGuardianEvent | null {
  const key = cleanString(id);
  if (key === "") return null;
  const row = db.sqlite.query<Record<string, unknown>, [string]>(
    `select ${COLUMNS} from ${TABLE} where id=?`
  ).get(key);
  return row ? mapEvent(row) : null;
}

export function listPiGuardianEvents(
  db: RunnerDatabase,
  filter: PiGuardianEventFilter = {}
): PiGuardianEvent[] {
  return listRows(db, TABLE, COLUMNS, mapEvent, buildFilter([
    ["project_id=?", filter.projectId],
    ["issue_id=?", filter.issueId],
    ["run_group_id=?", filter.runGroupId],
    ["source=?", filter.source],
    ["status=?", filter.status]
  ], "sequence_id asc"));
}

export function updatePiGuardianEvent(
  db: RunnerDatabase,
  id: string,
  input: PiGuardianEventInput
): PiGuardianEvent {
  const patch = normalizePatch(input);
  const columns = UPDATE_COLUMNS.filter((column) => patch[column] !== undefined);
  if (columns.length > 0) {
    db.sqlite.run(`update ${TABLE} set ${columns.map((column) => `${column}=?`).join(", ")}, updated_at=? where id=?`, [
      ...columns.map((column) => patch[column] as SQLValue), now(), cleanString(id)
    ]);
  }
  const event = getPiGuardianEvent(db, id);
  if (!event) throw new Error(`PI guardian event ${cleanString(id)} not found`);
  return event;
}

function normalizeCreate(input: PiGuardianEventInput): PiGuardianEvent {
  const id = cleanString(input.id) || crypto.randomUUID();
  const eventType = requiredString(input.event_type, "event_type");
  const normalizedPayload = jsonPayload(input.normalized_payload_json);
  const createdAt = cleanString(input.created_at) || now();
  const idempotencyKey = cleanString(input.idempotency_key) ||
    defaultEventKey(input, eventType, normalizedPayload, createdAt);
  return {
    consumed_at: cleanString(input.consumed_at), conversation_id: cleanString(input.conversation_id),
    created_at: createdAt, error: cleanString(input.error), event_type: eventType, id,
    idempotency_key: idempotencyKey, issue_id: integerInput(input.issue_id),
    lease_expires_at: cleanString(input.lease_expires_at), lease_owner: cleanString(input.lease_owner),
    normalized_payload_json: normalizedPayload, project_id: cleanString(input.project_id),
    redaction_profile: cleanString(input.redaction_profile) || "prompt", run_group_id: cleanString(input.run_group_id),
    sequence_id: 0, severity: cleanString(input.severity) || "info", source: cleanString(input.source),
    source_event_id: cleanString(input.source_event_id), source_sequence: integerInput(input.source_sequence),
    status: cleanString(input.status) || "pending", updated_at: ""
  };
}

function normalizePatch(input: PiGuardianEventInput): PiGuardianEventInput {
  return {
    ...input,
    normalized_payload_json: input.normalized_payload_json === undefined ? undefined : jsonPayload(input.normalized_payload_json),
    source_sequence: input.source_sequence === undefined ? undefined : integerInput(input.source_sequence)
  };
}

function mapEvent(row: Record<string, unknown>): PiGuardianEvent {
  return {
    consumed_at: optionalString(row.consumed_at), conversation_id: optionalString(row.conversation_id),
    created_at: requiredString(row.created_at, `${TABLE}.created_at`), error: optionalString(row.error),
    event_type: requiredString(row.event_type, `${TABLE}.event_type`), id: requiredString(row.id, `${TABLE}.id`),
    idempotency_key: requiredString(row.idempotency_key, `${TABLE}.idempotency_key`),
    issue_id: integerValue(row.issue_id, `${TABLE}.issue_id`),
    lease_expires_at: optionalString(row.lease_expires_at), lease_owner: optionalString(row.lease_owner),
    normalized_payload_json: optionalString(row.normalized_payload_json) || "{}", project_id: optionalString(row.project_id),
    redaction_profile: optionalString(row.redaction_profile) || "prompt", run_group_id: optionalString(row.run_group_id),
    sequence_id: integerValue(row.sequence_id, `${TABLE}.sequence_id`), severity: optionalString(row.severity) || "info",
    source: optionalString(row.source), source_event_id: optionalString(row.source_event_id),
    source_sequence: integerValue(row.source_sequence, `${TABLE}.source_sequence`),
    status: requiredString(row.status, `${TABLE}.status`), updated_at: requiredString(row.updated_at, `${TABLE}.updated_at`)
  };
}

function mustGetPiGuardianEvent(db: RunnerDatabase, record: PiGuardianEvent): PiGuardianEvent {
  const event = findExistingEvent(db, record);
  if (!event) throw new Error("PI guardian event missing after write");
  return event;
}

function findExistingEvent(db: RunnerDatabase, record: PiGuardianEvent): PiGuardianEvent | null {
  const row = db.sqlite.query<Record<string, unknown>, [string, string, string, string]>(
    `select ${COLUMNS} from ${TABLE}
      where id=? or (source=? and source_event_id=? and idempotency_key=?)
      order by sequence_id asc limit 1`
  ).get(record.id, record.source, record.source_event_id, record.idempotency_key);
  return row ? mapEvent(row) : null;
}

function defaultEventKey(
  input: PiGuardianEventInput,
  eventType: string,
  payload: string,
  createdAt: string
): string {
  const projectID = cleanString(input.project_id);
  const scope = eventScope(input);
  const sourceEventID = cleanString(input.source_event_id);
  if (sourceEventID !== "") return `${eventType}:${projectID}:${scope}:${sourceEventID}`;

  const sourceSequence = integerInput(input.source_sequence);
  if (sourceSequence > 0) {
    return `${eventType}:${projectID}:${scope}:${cleanString(input.source)}:${sourceSequence}`;
  }

  const hash = payloadHash(payload);
  const bucket = minuteBucket(createdAt);
  if (isFailureLike(eventType)) {
    return `${eventType}:${projectID}:${scope}:${diagnosisCode(payload)}:${bucket}:${hash}`;
  }
  return `${eventType}:${projectID}:${scope}:${hash}:${bucket}`;
}

function eventScope(input: PiGuardianEventInput): string {
  const issueScope = integerInput(input.issue_id) > 0 ? String(integerInput(input.issue_id)) : "";
  return issueScope || cleanString(input.run_group_id) || cleanString(input.conversation_id);
}

function payloadHash(payload: string): string {
  return `sha256:${createHash("sha256").update(canonicalPayload(payload)).digest("hex")}`;
}

function canonicalPayload(payload: string): string {
  try {
    return stableJson(JSON.parse(payload) as unknown);
  } catch {
    return payload;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return stableObjectJson(value as Record<string, unknown>);
  return JSON.stringify(value ?? null);
}

function stableObjectJson(value: Record<string, unknown>): string {
  const body = Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",");
  return `{${body}}`;
}

function minuteBucket(timestamp: string): string {
  const time = Date.parse(timestamp);
  const raw = Number.isFinite(time) ? time : Date.now();
  const bucket = Math.floor(raw / MINUTE_MS) * MINUTE_MS;
  return new Date(bucket).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function isFailureLike(eventType: string): boolean {
  return /fail|error|disconnect|recovery|recover|provider/i.test(eventType);
}

function diagnosisCode(payload: string): string {
  const parsed = parsePayloadObject(payload);
  return safeKeyPart(parsed?.diagnosis_code) || safeKeyPart(parsed?.code) ||
    safeKeyPart(parsed?.reason) || "unknown";
}

function parsePayloadObject(payload: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function safeKeyPart(value: unknown): string {
  const text = cleanString(value).toLowerCase();
  return text.replace(/[^a-z0-9_:-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, KEY_PART_LIMIT);
}

function jsonPayload(value: unknown): string {
  if (typeof value === "string") return jsonText(value, "{}");
  return JSON.stringify(value ?? {});
}

function insertColumns(): string {
  return `id, source, source_event_id, source_sequence, event_type, project_id,
    issue_id, run_group_id, conversation_id, severity, normalized_payload_json,
    redaction_profile, status, lease_owner, lease_expires_at, consumed_at,
    idempotency_key, error, created_at, updated_at`;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
