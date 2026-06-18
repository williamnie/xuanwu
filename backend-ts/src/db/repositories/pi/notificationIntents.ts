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

export type PiNotificationIntent = {
  ack_deadline_at: string; ack_required: number; ack_retry_count: number;
  ack_status: string; conversation_id: string; created_at: string; decision: string;
  error: string; flush_after_at: string; flush_bucket: string; flush_reason: string;
  flush_sequence: number; id: string; idempotency_key: string; issue_id: number;
  kind: string; next_ack_retry_at: string; payload_json: string; preference_id: string;
  project_id: string; ready_at: string; requires_user: number; run_group_id: string;
  sent_at: string; sent_outbox_id: number; severity: string; source_event_id: string;
  source_event_sequence_id: number; source_event_type: string; state: string; summary: string;
  target_channel: string; target_chat_id: string; target_message_id: string;
  target_thread_id: string; updated_at: string;
};
export type PiNotificationIntentInput = PatchInput<PiNotificationIntent>;
export type PiNotificationIntentFilter = {
  issueId?: number; kind?: string; projectId?: string; runGroupId?: string; state?: string;
};

type SQLValue = string | number;
const TABLE = "pi_notification_intents";
const COLUMNS = `id, source_event_id, source_event_sequence_id, source_event_type,
  idempotency_key, project_id, issue_id, run_group_id, conversation_id,
  target_channel, target_chat_id, target_thread_id, target_message_id, kind,
  severity, requires_user, decision, state, summary, payload_json, preference_id,
  flush_reason, flush_sequence, flush_bucket, flush_after_at, ready_at,
  sent_outbox_id, sent_at, ack_required, ack_status, ack_deadline_at,
  ack_retry_count, next_ack_retry_at, error, created_at, updated_at`;
const UPDATE_COLUMNS = [
  "decision", "state", "summary", "payload_json", "preference_id", "flush_after_at", "ready_at",
  "sent_outbox_id", "sent_at", "ack_status", "ack_deadline_at", "ack_retry_count", "next_ack_retry_at", "error"
] as const;

export function createPiNotificationIntent(
  db: RunnerDatabase,
  input: PiNotificationIntentInput
): PiNotificationIntent {
  const record = normalizeCreate(input);
  const existing = findExistingIntent(db, record);
  if (existing) return existing;
  const timestamp = now();
  db.sqlite.run(`insert or ignore into ${TABLE} (${COLUMNS}) values (${placeholders(36)})`, [
    record.id, record.source_event_id, record.source_event_sequence_id, record.source_event_type,
    record.idempotency_key, record.project_id, record.issue_id, record.run_group_id,
    record.conversation_id, record.target_channel, record.target_chat_id, record.target_thread_id,
    record.target_message_id, record.kind, record.severity, record.requires_user, record.decision,
    record.state, record.summary, record.payload_json, record.preference_id, record.flush_reason,
    record.flush_sequence, record.flush_bucket, record.flush_after_at, record.ready_at,
    record.sent_outbox_id, record.sent_at, record.ack_required, record.ack_status,
    record.ack_deadline_at, record.ack_retry_count, record.next_ack_retry_at, record.error,
    timestamp, timestamp
  ]);
  return requireExistingIntent(db, record);
}

export function getPiNotificationIntent(db: RunnerDatabase, id: string): PiNotificationIntent | null {
  const key = cleanString(id);
  if (key === "") return null;
  const row = db.sqlite.query<Record<string, unknown>, [string]>(
    `select ${COLUMNS} from ${TABLE} where id=?`
  ).get(key);
  return row ? mapIntent(row) : null;
}

export function listPiNotificationIntents(
  db: RunnerDatabase,
  filter: PiNotificationIntentFilter = {}
): PiNotificationIntent[] {
  return listRows(db, TABLE, COLUMNS, mapIntent, buildFilter([
    ["project_id=?", filter.projectId],
    ["issue_id=?", filter.issueId],
    ["run_group_id=?", filter.runGroupId],
    ["kind=?", filter.kind],
    ["state=?", filter.state]
  ], "created_at asc, flush_sequence asc, id asc"));
}

export function updatePiNotificationIntent(
  db: RunnerDatabase,
  id: string,
  input: PiNotificationIntentInput
): PiNotificationIntent {
  const patch = normalizePatch(input);
  const columns = UPDATE_COLUMNS.filter((column) => patch[column] !== undefined);
  if (columns.length > 0) {
    db.sqlite.run(`update ${TABLE} set ${columns.map((column) => `${column}=?`).join(", ")}, updated_at=? where id=?`, [
      ...columns.map((column) => patch[column] as SQLValue), now(), cleanString(id)
    ]);
  }
  const intent = getPiNotificationIntent(db, id);
  if (!intent) throw new Error(`PI notification intent ${cleanString(id)} not found`);
  return intent;
}

function normalizeCreate(input: PiNotificationIntentInput): PiNotificationIntent {
  const kind = requiredString(input.kind, "kind");
  const targetChannel = cleanString(input.target_channel);
  const runGroupID = cleanString(input.run_group_id);
  const flushReason = cleanString(input.flush_reason);
  const flushSequence = integerInput(input.flush_sequence);
  const flushBucket = cleanString(input.flush_bucket);
  const idempotencyKey = defaultIntentKey({
    explicitKey: cleanString(input.idempotency_key), flushBucket, flushReason,
    flushSequence, input, kind, runGroupID, targetChannel
  });
  return {
    ack_deadline_at: cleanString(input.ack_deadline_at), ack_required: integerInput(input.ack_required),
    ack_retry_count: integerInput(input.ack_retry_count), ack_status: cleanString(input.ack_status),
    conversation_id: cleanString(input.conversation_id), created_at: "", decision: cleanString(input.decision) || "aggregate",
    error: cleanString(input.error), flush_after_at: cleanString(input.flush_after_at), flush_bucket: flushBucket,
    flush_reason: flushReason, flush_sequence: flushSequence, id: cleanString(input.id) || crypto.randomUUID(),
    idempotency_key: idempotencyKey, issue_id: integerInput(input.issue_id), kind,
    next_ack_retry_at: cleanString(input.next_ack_retry_at), payload_json: payloadText(input.payload_json),
    preference_id: cleanString(input.preference_id), project_id: cleanString(input.project_id),
    ready_at: cleanString(input.ready_at), requires_user: integerInput(input.requires_user), run_group_id: runGroupID,
    sent_at: cleanString(input.sent_at), sent_outbox_id: integerInput(input.sent_outbox_id),
    severity: cleanString(input.severity) || "info", source_event_id: cleanString(input.source_event_id),
    source_event_sequence_id: integerInput(input.source_event_sequence_id),
    source_event_type: cleanString(input.source_event_type), state: cleanString(input.state) || "pending",
    summary: cleanString(input.summary), target_channel: targetChannel, target_chat_id: cleanString(input.target_chat_id),
    target_message_id: cleanString(input.target_message_id), target_thread_id: cleanString(input.target_thread_id),
    updated_at: ""
  };
}

function normalizePatch(input: PiNotificationIntentInput): PiNotificationIntentInput {
  return {
    ...input,
    ack_retry_count: input.ack_retry_count === undefined ? undefined : integerInput(input.ack_retry_count),
    payload_json: input.payload_json === undefined ? undefined : payloadText(input.payload_json),
    sent_outbox_id: input.sent_outbox_id === undefined ? undefined : integerInput(input.sent_outbox_id)
  };
}

function defaultIntentKey(args: {
  explicitKey: string; flushBucket: string; flushReason: string; flushSequence: number;
  input: PiNotificationIntentInput; kind: string; runGroupID: string; targetChannel: string;
}): string {
  if (args.kind === "digest") {
    const flushAnchor = args.flushSequence > 0 ? String(args.flushSequence) : args.flushBucket;
    if (args.runGroupID === "" || args.flushReason === "" || flushAnchor === "" || args.targetChannel === "") {
      throw new Error("digest intent requires run_group_id, flush_reason, flush_sequence or flush_bucket, and target_channel");
    }
    return `digest:${args.runGroupID}:${args.flushReason}:${flushAnchor}:${args.targetChannel}`;
  }
  if (args.explicitKey !== "") return args.explicitKey;
  const source = cleanString(args.input.source_event_id) || String(integerInput(args.input.source_event_sequence_id));
  return `${args.kind}:${cleanString(args.input.project_id)}:${integerInput(args.input.issue_id)}:${source}:${args.targetChannel}`;
}

function mapIntent(row: Record<string, unknown>): PiNotificationIntent {
  return {
    ack_deadline_at: optionalString(row.ack_deadline_at), ack_required: integerValue(row.ack_required, "ack_required"),
    ack_retry_count: integerValue(row.ack_retry_count, "ack_retry_count"), ack_status: optionalString(row.ack_status),
    conversation_id: optionalString(row.conversation_id), created_at: requiredString(row.created_at, `${TABLE}.created_at`),
    decision: requiredString(row.decision, `${TABLE}.decision`), error: optionalString(row.error),
    flush_after_at: optionalString(row.flush_after_at), flush_bucket: optionalString(row.flush_bucket),
    flush_reason: optionalString(row.flush_reason), flush_sequence: integerValue(row.flush_sequence, "flush_sequence"),
    id: requiredString(row.id, `${TABLE}.id`), idempotency_key: requiredString(row.idempotency_key, `${TABLE}.idempotency_key`),
    issue_id: integerValue(row.issue_id, "issue_id"), kind: requiredString(row.kind, `${TABLE}.kind`),
    next_ack_retry_at: optionalString(row.next_ack_retry_at), payload_json: optionalString(row.payload_json) || "{}",
    preference_id: optionalString(row.preference_id), project_id: optionalString(row.project_id),
    ready_at: optionalString(row.ready_at), requires_user: integerValue(row.requires_user, "requires_user"),
    run_group_id: optionalString(row.run_group_id), sent_at: optionalString(row.sent_at),
    sent_outbox_id: integerValue(row.sent_outbox_id, "sent_outbox_id"), severity: optionalString(row.severity) || "info",
    source_event_id: optionalString(row.source_event_id), source_event_sequence_id: integerValue(row.source_event_sequence_id, "source_event_sequence_id"),
    source_event_type: optionalString(row.source_event_type), state: requiredString(row.state, `${TABLE}.state`),
    summary: optionalString(row.summary), target_channel: optionalString(row.target_channel),
    target_chat_id: optionalString(row.target_chat_id), target_message_id: optionalString(row.target_message_id),
    target_thread_id: optionalString(row.target_thread_id), updated_at: requiredString(row.updated_at, `${TABLE}.updated_at`)
  };
}

function requireExistingIntent(db: RunnerDatabase, record: PiNotificationIntent): PiNotificationIntent {
  const intent = findExistingIntent(db, record);
  if (!intent) throw new Error("PI notification intent missing after write");
  return intent;
}

function findExistingIntent(db: RunnerDatabase, record: PiNotificationIntent): PiNotificationIntent | null {
  const row = db.sqlite.query<Record<string, unknown>, [string, string]>(
    `select ${COLUMNS} from ${TABLE} where id=? or idempotency_key=? order by created_at asc, id asc limit 1`
  ).get(record.id, record.idempotency_key);
  return row ? mapIntent(row) : null;
}

function payloadText(value: unknown): string {
  if (typeof value === "string") return jsonText(value, "{}");
  return JSON.stringify(value ?? {});
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
