import type { RunnerDatabase } from "../database.ts";
import {
  cleanValue,
  integerRow,
  optionalString,
  positiveID,
  requiredString,
  safeContent
} from "./imReplyOutboxSupport.ts";
import { getSyncOutbox } from "./imReplyOutbox.ts";
import type { SQLValue, SyncOutboxRecord } from "./imReplyOutboxTypes.ts";

const OUTBOX_COLUMNS = `id, source, reply_draft_id, external_event_id, issue_id,
  target_chat_id, target_thread_id, target_message_id, content, status, risk,
  created_by, approval_action_id, attempt_count, cooldown_until, feishu_message_id,
  last_error, max_attempts, retry_after_seconds, sent_at, created_at, updated_at`;

type StatusPatch = {
  cooldown_until?: string;
  feishu_message_id?: string;
  last_error?: string;
  retry_after_seconds?: number;
  sent_at?: string;
  status: string;
};

export function listDispatchableSyncOutbox(db: RunnerDatabase, options: {
  limit?: number;
  now?: Date;
  source?: string;
} = {}): SyncOutboxRecord[] {
  const now = (options.now ?? new Date()).toISOString();
  const limit = positiveLimit(options.limit);
  const source = cleanValue(options.source);
  const args: SQLValue[] = source === "" ? [now, limit] : [now, source, limit];
  const where = source === "" ? "" : " and source=?";
  return db.sqlite.query<Record<string, unknown>, SQLValue[]>(
    `select ${OUTBOX_COLUMNS} from sync_outbox
     where operation_kind='im_reply' and status in ('pending', 'queued', 'retry') and feishu_message_id=''
       and (cooldown_until='' or cooldown_until<=?)${where}
     order by created_at asc, id asc limit ?`
  ).all(...args).map(mapOutbox);
}

export function claimSyncOutboxSending(
  db: RunnerDatabase,
  id: number,
  timestamp = new Date()
): SyncOutboxRecord | null {
  return db.transaction(() => {
    const outbox = getSyncOutbox(db, id);
    if (!outbox || !claimable(outbox, timestamp)) return null;
    db.sqlite.run(`update sync_outbox set status='sending', attempt_count=attempt_count+1,
      last_error='', retry_after_seconds=0, updated_at=? where id=?`, [timestamp.toISOString(), id]);
    return getSyncOutbox(db, id);
  }).immediate();
}

export function markSyncOutboxSent(
  db: RunnerDatabase,
  id: number,
  input: { feishuMessageId: string; timestamp?: Date }
): SyncOutboxRecord {
  const timestamp = input.timestamp ?? new Date();
  updateOutboxStatus(db, id, {
    cooldown_until: "",
    feishu_message_id: cleanValue(input.feishuMessageId),
    last_error: "",
    retry_after_seconds: 0,
    sent_at: timestamp.toISOString(),
    status: "sent"
  }, timestamp);
  return mustGetSyncOutbox(db, id);
}

export function markSyncOutboxFailed(
  db: RunnerDatabase,
  id: number,
  input: { error: string; timestamp?: Date }
): SyncOutboxRecord {
  const timestamp = input.timestamp ?? new Date();
  updateOutboxStatus(db, id, {
    cooldown_until: "",
    last_error: safeContent(input.error),
    retry_after_seconds: 0,
    status: "failed"
  }, timestamp);
  return mustGetSyncOutbox(db, id);
}

export function markSyncOutboxRetry(
  db: RunnerDatabase,
  id: number,
  input: { error: string; retryAfterSeconds?: number; timestamp?: Date }
): SyncOutboxRecord {
  const timestamp = input.timestamp ?? new Date();
  const current = mustGetSyncOutbox(db, id);
  if (current.attempt_count >= current.max_attempts) {
    return markSyncOutboxFailed(db, id, { error: input.error, timestamp });
  }
  const seconds = positiveRetrySeconds(input.retryAfterSeconds);
  updateOutboxStatus(db, id, {
    cooldown_until: new Date(timestamp.getTime() + seconds * 1000).toISOString(),
    last_error: safeContent(input.error),
    retry_after_seconds: seconds,
    status: "retry"
  }, timestamp);
  return mustGetSyncOutbox(db, id);
}

function mapOutbox(row: Record<string, unknown>): SyncOutboxRecord {
  return {
    id: integerRow(row.id, "sync_outbox.id"), source: requiredString(row.source, "sync_outbox.source"),
    reply_draft_id: integerRow(row.reply_draft_id, "sync_outbox.reply_draft_id"),
    external_event_id: integerRow(row.external_event_id, "sync_outbox.external_event_id"),
    issue_id: integerRow(row.issue_id, "sync_outbox.issue_id"), target_chat_id: optionalString(row.target_chat_id),
    target_thread_id: optionalString(row.target_thread_id), target_message_id: optionalString(row.target_message_id),
    content: requiredString(row.content, "sync_outbox.content"), status: requiredString(row.status, "sync_outbox.status"),
    risk: requiredString(row.risk, "sync_outbox.risk"), created_by: requiredString(row.created_by, "sync_outbox.created_by"),
    approval_action_id: optionalString(row.approval_action_id),
    attempt_count: integerRow(row.attempt_count, "sync_outbox.attempt_count"),
    cooldown_until: optionalString(row.cooldown_until),
    feishu_message_id: optionalString(row.feishu_message_id),
    last_error: optionalString(row.last_error),
    max_attempts: integerRow(row.max_attempts, "sync_outbox.max_attempts"),
    retry_after_seconds: integerRow(row.retry_after_seconds, "sync_outbox.retry_after_seconds"),
    sent_at: optionalString(row.sent_at),
    created_at: requiredString(row.created_at, "sync_outbox.created_at"),
    updated_at: requiredString(row.updated_at, "sync_outbox.updated_at")
  };
}

function mustGetSyncOutbox(db: RunnerDatabase, id: number): SyncOutboxRecord {
  const outbox = getSyncOutbox(db, id);
  if (!outbox) throw new Error("sync outbox not found");
  return outbox;
}

function updateOutboxStatus(db: RunnerDatabase, id: number, patch: StatusPatch, timestamp: Date): void {
  if (!positiveID(id)) throw new Error("sync outbox id is required");
  db.sqlite.run(`update sync_outbox set status=?, cooldown_until=?, feishu_message_id=?,
    last_error=?, retry_after_seconds=?, sent_at=?, updated_at=? where id=?`, [
    patch.status, patch.cooldown_until ?? "", patch.feishu_message_id ?? "",
    patch.last_error ?? "", patch.retry_after_seconds ?? 0, patch.sent_at ?? "",
    timestamp.toISOString(), id
  ]);
}

function claimable(outbox: SyncOutboxRecord, timestamp: Date): boolean {
  if (!["pending", "queued", "retry"].includes(outbox.status)) return false;
  if (outbox.feishu_message_id !== "") return false;
  return outbox.cooldown_until === "" || outbox.cooldown_until <= timestamp.toISOString();
}

function positiveLimit(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 20;
}

function positiveRetrySeconds(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : 10;
}
