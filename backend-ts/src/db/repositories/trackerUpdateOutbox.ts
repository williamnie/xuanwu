import type { TrackerAdapterReceipt, TrackerUpdateCommand } from "../../integrations/tracker/contracts.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import type { RunnerDatabase } from "../database.ts";

export type TrackerUpdateOutboxRecord = {
  attention_ref: string;
  attempt_count: number;
  authorization_action_id: string;
  command: TrackerUpdateCommand;
  cooldown_until: string;
  created_at: string;
  id: number;
  issue_id: number;
  last_error: string;
  max_attempts: number;
  provider_request_ref: string;
  receipt: TrackerAdapterReceipt | null;
  retry_after_seconds: number;
  sent_at: string;
  status: "failed" | "queued" | "retry" | "sending" | "sent";
  updated_at: string;
};

export type EnqueueTrackerUpdateOutboxInput = {
  authorization_action_id: string;
  command: TrackerUpdateCommand;
  issue_id: number;
  max_attempts?: number;
};

const COLUMNS = `id, source, issue_id, content, status, approval_action_id,
  attempt_count, cooldown_until, last_error, max_attempts, retry_after_seconds,
  sent_at, operation_kind, project_id, handoff_id, work_id,
  target_external_id, target_external_type, dedupe_key, payload_json, result_json,
  correlation_id, provider_request_ref, attention_ref, created_at, updated_at`;

export function enqueueTrackerUpdateOutbox(
  db: RunnerDatabase,
  input: EnqueueTrackerUpdateOutboxInput,
  timestamp = new Date()
): { created: boolean; record: TrackerUpdateOutboxRecord } {
  const existing = getTrackerUpdateOutboxByDedupe(
    db,
    input.command.target.provider_id,
    input.command.idempotency_key
  );
  if (existing) {
    assertSameRequest(existing, input);
    return { created: false, record: existing };
  }
  const now = timestamp.toISOString();
  const result = db.sqlite.run(`insert or ignore into sync_outbox (
    source, issue_id, content, status, risk, created_by, approval_action_id,
    max_attempts, operation_kind, project_id, handoff_id, work_id,
    target_external_id, target_external_type, dedupe_key, payload_json,
    correlation_id, created_at, updated_at
  ) values (?, ?, ?, 'queued', 'medium', 'handoff', ?, ?, 'tracker_update', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    input.command.target.provider_id,
    positiveInteger(input.issue_id, "issue id"),
    input.command.comment,
    requiredText(input.authorization_action_id, "authorization action id"),
    boundedAttempts(input.max_attempts),
    input.command.project_id,
    input.command.handoff_id,
    input.command.work_id,
    input.command.target.external_id,
    input.command.target.external_type,
    input.command.idempotency_key,
    JSON.stringify(input.command),
    input.command.correlation_id,
    now,
    now
  ]);
  const saved = getTrackerUpdateOutboxByDedupe(
    db,
    input.command.target.provider_id,
    input.command.idempotency_key
  );
  if (!saved) throw new Error("tracker update outbox missing after write");
  assertSameRequest(saved, input);
  return { created: result.changes === 1, record: saved };
}

export function getTrackerUpdateOutbox(db: RunnerDatabase, id: number): TrackerUpdateOutboxRecord | null {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const row = db.sqlite.query<Record<string, unknown>, [number]>(
    `select ${COLUMNS} from sync_outbox where id=? and operation_kind='tracker_update'`
  ).get(id);
  return row ? mapRecord(row) : null;
}

export function getTrackerUpdateOutboxByDedupe(
  db: RunnerDatabase,
  providerID: string,
  dedupeKey: string
): TrackerUpdateOutboxRecord | null {
  const row = db.sqlite.query<Record<string, unknown>, [string, string]>(
    `select ${COLUMNS} from sync_outbox
      where source=? and operation_kind='tracker_update' and dedupe_key=?`
  ).get(requiredText(providerID, "tracker provider id"), requiredText(dedupeKey, "dedupe key"));
  return row ? mapRecord(row) : null;
}

export function listDispatchableTrackerUpdates(db: RunnerDatabase, input: {
  limit?: number;
  now?: Date;
} = {}): TrackerUpdateOutboxRecord[] {
  const now = (input.now ?? new Date()).toISOString();
  return db.sqlite.query<Record<string, unknown>, [string, string, number]>(
    `select ${COLUMNS} from sync_outbox
      where operation_kind='tracker_update' and (
        (status in ('queued', 'retry') and (cooldown_until='' or cooldown_until<=?)) or
        (status='sending' and cooldown_until<>'' and cooldown_until<=?)
      ) order by created_at asc, id asc limit ?`
  ).all(now, now, listLimit(input.limit)).map(mapRecord);
}

export function claimTrackerUpdateOutbox(db: RunnerDatabase, id: number, input: {
  lease_seconds?: number;
  now?: Date;
} = {}): TrackerUpdateOutboxRecord | null {
  const now = input.now ?? new Date();
  const nowText = now.toISOString();
  const leaseUntil = new Date(now.getTime() + positiveSeconds(input.lease_seconds, 60) * 1000).toISOString();
  const result = db.sqlite.run(`update sync_outbox set status='sending',
    attempt_count=attempt_count+1, cooldown_until=?, last_error='',
    retry_after_seconds=0, updated_at=?
    where id=? and operation_kind='tracker_update' and (
      (status in ('queued', 'retry') and (cooldown_until='' or cooldown_until<=?)) or
      (status='sending' and cooldown_until<>'' and cooldown_until<=?)
    )`, [leaseUntil, nowText, id, nowText, nowText]);
  return result.changes === 1 ? requireRecord(db, id) : null;
}

export function markTrackerUpdateRetry(db: RunnerDatabase, id: number, input: {
  error: string;
  retry_after_seconds?: number;
  timestamp?: Date;
}): TrackerUpdateOutboxRecord {
  const timestamp = input.timestamp ?? new Date();
  const seconds = positiveSeconds(input.retry_after_seconds, 60);
  updateSending(db, id, {
    attention_ref: "",
    cooldown_until: new Date(timestamp.getTime() + seconds * 1000).toISOString(),
    last_error: safeError(input.error),
    provider_request_ref: "",
    result_json: "{}",
    retry_after_seconds: seconds,
    sent_at: "",
    status: "retry"
  }, timestamp);
  return requireRecord(db, id);
}

export function markTrackerUpdateSent(db: RunnerDatabase, id: number, input: {
  receipt: TrackerAdapterReceipt;
  timestamp?: Date;
}): TrackerUpdateOutboxRecord {
  const timestamp = input.timestamp ?? new Date();
  updateSending(db, id, {
    attention_ref: "",
    cooldown_until: "",
    last_error: "",
    provider_request_ref: input.receipt.provider_request_ref,
    result_json: JSON.stringify(input.receipt),
    retry_after_seconds: 0,
    sent_at: timestamp.toISOString(),
    status: "sent"
  }, timestamp);
  return requireRecord(db, id);
}

export function markTrackerUpdateFailed(db: RunnerDatabase, id: number, input: {
  attention_ref: string;
  error: string;
  timestamp?: Date;
}): TrackerUpdateOutboxRecord {
  const timestamp = input.timestamp ?? new Date();
  updateSending(db, id, {
    attention_ref: requiredText(input.attention_ref, "attention ref"),
    cooldown_until: "",
    last_error: safeError(input.error),
    provider_request_ref: "",
    result_json: "{}",
    retry_after_seconds: 0,
    sent_at: "",
    status: "failed"
  }, timestamp);
  return requireRecord(db, id);
}

function updateSending(
  db: RunnerDatabase,
  id: number,
  patch: {
    attention_ref: string;
    cooldown_until: string;
    last_error: string;
    provider_request_ref: string;
    result_json: string;
    retry_after_seconds: number;
    sent_at: string;
    status: TrackerUpdateOutboxRecord["status"];
  },
  timestamp: Date
): void {
  const result = db.sqlite.run(`update sync_outbox set status=?, cooldown_until=?,
    last_error=?, retry_after_seconds=?, sent_at=?, result_json=?,
    provider_request_ref=?, attention_ref=?, updated_at=?
    where id=? and operation_kind='tracker_update' and status='sending'`, [
    patch.status, patch.cooldown_until, patch.last_error, patch.retry_after_seconds,
    patch.sent_at, patch.result_json, patch.provider_request_ref, patch.attention_ref,
    timestamp.toISOString(), id
  ]);
  if (result.changes !== 1) throw new Error("tracker update outbox compare-and-set failed");
}

function mapRecord(row: Record<string, unknown>): TrackerUpdateOutboxRecord {
  const command = jsonObject(row.payload_json, "sync_outbox.payload_json") as TrackerUpdateCommand;
  return {
    attention_ref: optionalString(row.attention_ref),
    attempt_count: integer(row.attempt_count, "sync_outbox.attempt_count"),
    authorization_action_id: requiredString(row.approval_action_id, "sync_outbox.approval_action_id"),
    command,
    cooldown_until: optionalString(row.cooldown_until),
    created_at: requiredString(row.created_at, "sync_outbox.created_at"),
    id: integer(row.id, "sync_outbox.id"),
    issue_id: integer(row.issue_id, "sync_outbox.issue_id"),
    last_error: optionalString(row.last_error),
    max_attempts: integer(row.max_attempts, "sync_outbox.max_attempts"),
    provider_request_ref: optionalString(row.provider_request_ref),
    receipt: receipt(row.result_json),
    retry_after_seconds: integer(row.retry_after_seconds, "sync_outbox.retry_after_seconds"),
    sent_at: optionalString(row.sent_at),
    status: outboxStatus(row.status),
    updated_at: requiredString(row.updated_at, "sync_outbox.updated_at")
  };
}

function assertSameRequest(record: TrackerUpdateOutboxRecord, input: EnqueueTrackerUpdateOutboxInput): void {
  if (record.authorization_action_id !== input.authorization_action_id || record.issue_id !== input.issue_id ||
    JSON.stringify(record.command) !== JSON.stringify(input.command)) {
    throw new Error("tracker update dedupe key conflicts with an existing request");
  }
}

function requireRecord(db: RunnerDatabase, id: number): TrackerUpdateOutboxRecord {
  const record = getTrackerUpdateOutbox(db, id);
  if (!record) throw new Error("tracker update outbox not found");
  return record;
}

function receipt(value: unknown): TrackerAdapterReceipt | null {
  const object = jsonObject(value, "sync_outbox.result_json");
  return Object.keys(object).length === 0 ? null : object as TrackerAdapterReceipt;
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  const text = typeof value === "string" ? value : "";
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {}
  throw new Error(`${label} must be a JSON object`);
}

function outboxStatus(value: unknown): TrackerUpdateOutboxRecord["status"] {
  const status = optionalString(value);
  if (["failed", "queued", "retry", "sending", "sent"].includes(status)) {
    return status as TrackerUpdateOutboxRecord["status"];
  }
  throw new Error(`invalid tracker update outbox status: ${status}`);
}

function boundedAttempts(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? Math.min(value, 10) : 3;
}

function positiveSeconds(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? Math.min(value, 86_400) : fallback;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} is required`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return value;
}

function requiredText(value: unknown, label: string): string {
  const text = optionalString(value);
  if (text === "") throw new Error(`${label} is required`);
  return text;
}

function requiredString(value: unknown, label: string): string {
  return requiredText(value, label);
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeError(value: unknown): string {
  return redactSensitiveText(typeof value === "string" ? value : String(value));
}

function listLimit(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? Math.min(value, 100) : 25;
}
