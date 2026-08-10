import type { RunnerDatabase } from "../database.ts";
import {
  cleanValue,
  filterQuery,
  integerRow,
  integerValue,
  optionalString,
  placeholders,
  positiveID,
  requiredString,
  safeContent
} from "./imReplyOutboxSupport.ts";
import type {
  ImReplyDraftFilter,
  ImReplyDraftInput,
  ImReplyDraftRecord,
  SQLValue,
  SyncOutboxRecord
} from "./imReplyOutboxTypes.ts";

export type { ImReplyDraftFilter, ImReplyDraftInput, ImReplyDraftRecord, SyncOutboxRecord };

type ReplyPatch = Partial<Omit<ImReplyDraftRecord, "created_at" | "id" | "updated_at">>;
const DRAFT_COLUMNS = `id, source, external_event_id, issue_id, target_chat_id,
  target_thread_id, target_message_id, content, status, risk, created_by,
  approval_action_id, rejection_reason, created_at, updated_at`;
const OUTBOX_COLUMNS = `id, source, reply_draft_id, external_event_id, issue_id,
  target_chat_id, target_thread_id, target_message_id, content, status, risk,
  created_by, approval_action_id, attempt_count, cooldown_until, feishu_message_id,
  last_error, max_attempts, retry_after_seconds, sent_at, created_at, updated_at,
  provider_request_ref, result_json, operation_kind, dedupe_key, payload_json, correlation_id`;
const PATCH_COLUMNS = [
  "source", "external_event_id", "issue_id", "target_chat_id", "target_thread_id",
  "target_message_id", "content", "status", "risk", "created_by", "approval_action_id",
  "rejection_reason"
] as const;

export function createImReplyDraft(db: RunnerDatabase, input: ImReplyDraftInput, timestamp = new Date()): ImReplyDraftRecord {
  const record = normalizeDraft(input, timestamp);
  db.sqlite.run(`insert into im_reply_drafts (${draftInsertColumns()}) values (${placeholders(14)})`, [
    record.source, record.external_event_id, record.issue_id, record.target_chat_id,
    record.target_thread_id, record.target_message_id, record.content, record.status,
    record.risk, record.created_by, record.approval_action_id, record.rejection_reason,
    record.created_at, record.updated_at
  ]);
  return mustGetImReplyDraft(db, lastInsertID(db));
}

export function getImReplyDraft(db: RunnerDatabase, id: number): ImReplyDraftRecord | null {
  if (!positiveID(id)) return null;
  const row = db.sqlite.query<Record<string, unknown>, [number]>(
    `select ${DRAFT_COLUMNS} from im_reply_drafts where id=?`
  ).get(id);
  return row ? mapDraft(row) : null;
}

export function listImReplyDrafts(db: RunnerDatabase, filter: ImReplyDraftFilter = {}): ImReplyDraftRecord[] {
  const query = filterQuery(filter);
  return db.sqlite.query<Record<string, unknown>, SQLValue[]>(
    `select ${DRAFT_COLUMNS} from im_reply_drafts${query.where} order by created_at desc, id desc`
  ).all(...query.args).map(mapDraft);
}

export function approveImReplyDraft(db: RunnerDatabase, id: number, timestamp = new Date()): {
  draft: ImReplyDraftRecord;
  outbox: SyncOutboxRecord;
} {
  return db.transaction(() => {
    requirePendingDraft(db, id);
    const draft = updateDraft(db, id, { status: "approved" }, timestamp);
    return { draft, outbox: createSyncOutbox(db, draft, timestamp) };
  }).immediate();
}

export function rejectImReplyDraft(
  db: RunnerDatabase,
  id: number,
  options: { reason?: string; timestamp?: Date } = {}
): ImReplyDraftRecord {
  return db.transaction(() => {
    const draft = getImReplyDraft(db, id);
    if (!draft) throw new Error("im reply draft not found");
    if (draft.status === "approved") throw new Error("approved draft cannot be rejected");
    if (draft.status === "rejected") return draft;
    return updateDraft(db, id, {
      rejection_reason: safeContent(options.reason), status: "rejected"
    }, options.timestamp ?? new Date());
  }).immediate();
}

export function listSyncOutbox(db: RunnerDatabase, filter: ImReplyDraftFilter = {}): SyncOutboxRecord[] {
  const query = filterQuery(filter);
  return db.sqlite.query<Record<string, unknown>, SQLValue[]>(
    `select ${OUTBOX_COLUMNS} from sync_outbox${query.where} order by created_at desc, id desc`
  ).all(...query.args).map(mapOutbox);
}

export function getSyncOutbox(db: RunnerDatabase, id: number): SyncOutboxRecord | null {
  if (!positiveID(id)) return null;
  const row = db.sqlite.query<Record<string, unknown>, [number]>(
    `select ${OUTBOX_COLUMNS} from sync_outbox where id=?`
  ).get(id);
  return row ? mapOutbox(row) : null;
}

export function getSyncOutboxByDedupe(
  db: RunnerDatabase,
  source: string,
  dedupeKey: string
): SyncOutboxRecord | null {
  const row = db.sqlite.query<Record<string, unknown>, [string, string]>(
    `select ${OUTBOX_COLUMNS} from sync_outbox
     where source=? and operation_kind='im_reply' and dedupe_key=? limit 1`
  ).get(cleanValue(source), cleanValue(dedupeKey));
  return row ? mapOutbox(row) : null;
}

export function setSyncOutboxCanonicalEnvelope(
  db: RunnerDatabase,
  id: number,
  input: { correlationId: string; dedupeKey: string; payloadJson: string; timestamp?: Date }
): SyncOutboxRecord {
  const timestamp = input.timestamp ?? new Date();
  db.sqlite.run(
    `update sync_outbox set dedupe_key=?, payload_json=?, correlation_id=?, updated_at=?
     where id=? and operation_kind='im_reply'`,
    [cleanValue(input.dedupeKey), cleanValue(input.payloadJson), cleanValue(input.correlationId), timestamp.toISOString(), id]
  );
  const outbox = getSyncOutbox(db, id);
  if (!outbox) throw new Error("sync outbox missing after canonical envelope write");
  return outbox;
}

function createSyncOutbox(db: RunnerDatabase, draft: ImReplyDraftRecord, timestamp: Date): SyncOutboxRecord {
  db.sqlite.run(`insert or ignore into sync_outbox (${outboxInsertColumns()}) values (${placeholders(14)})`, [
    draft.source, draft.id, draft.external_event_id, draft.issue_id,
    draft.target_chat_id, draft.target_thread_id, draft.target_message_id,
    draft.content, "pending", draft.risk, draft.created_by,
    draft.approval_action_id, timestamp.toISOString(), timestamp.toISOString()
  ]);
  return mustGetSyncOutboxByDraft(db, draft.id);
}

function updateDraft(db: RunnerDatabase, id: number, patch: ReplyPatch, timestamp: Date): ImReplyDraftRecord {
  const update = draftUpdate(patch, timestamp, id);
  if (update.sets.length === 0) return mustGetImReplyDraft(db, id);
  db.sqlite.run(`update im_reply_drafts set ${update.sets.join(", ")} where id=?`, update.values);
  return mustGetImReplyDraft(db, id);
}

function draftUpdate(patch: ReplyPatch, timestamp: Date, id: number): { sets: string[]; values: SQLValue[] } {
  const sets: string[] = [];
  const values: SQLValue[] = [];
  for (const column of PATCH_COLUMNS) pushPatch(sets, values, column, patch[column]);
  if (sets.length > 0) {
    sets.push("updated_at=?");
    values.push(timestamp.toISOString(), id);
  }
  return { sets, values };
}

function pushPatch(sets: string[], values: SQLValue[], column: string, value: unknown): void {
  if (value === undefined) return;
  sets.push(`${column}=?`);
  values.push(column === "content" || column === "rejection_reason" ? safeContent(value) : cleanValue(value));
}

function requirePendingDraft(db: RunnerDatabase, id: number): void {
  const draft = getImReplyDraft(db, id);
  if (!draft) throw new Error("im reply draft not found");
  if (draft.status === "approved") return;
  if (draft.status !== "pending") throw new Error(`im reply draft cannot be approved from status ${draft.status}`);
}

function normalizeDraft(input: ImReplyDraftInput, timestamp: Date): ImReplyDraftRecord {
  const record = {
    id: 0, source: cleanValue(input.source), external_event_id: integerValue(input.external_event_id),
    issue_id: integerValue(input.issue_id), target_chat_id: cleanValue(input.target_chat_id),
    target_thread_id: cleanValue(input.target_thread_id), target_message_id: cleanValue(input.target_message_id),
    content: safeContent(input.content), status: cleanValue(input.status) || "pending",
    risk: cleanValue(input.risk) || "low", created_by: cleanValue(input.created_by) || "pi",
    approval_action_id: cleanValue(input.approval_action_id), rejection_reason: cleanValue(input.rejection_reason),
    created_at: timestamp.toISOString(), updated_at: timestamp.toISOString()
  };
  requireDraft(record);
  return record;
}

function requireDraft(record: ImReplyDraftRecord): void {
  if (record.source === "") throw new Error("source is required");
  if (record.content === "") throw new Error("content is required");
  if (record.target_chat_id === "" && record.target_message_id === "") throw new Error("target chat or message is required");
}

function mapDraft(row: Record<string, unknown>): ImReplyDraftRecord {
  return {
    id: integerRow(row.id, "im_reply_drafts.id"), source: requiredString(row.source, "im_reply_drafts.source"),
    external_event_id: integerRow(row.external_event_id, "im_reply_drafts.external_event_id"),
    issue_id: integerRow(row.issue_id, "im_reply_drafts.issue_id"), target_chat_id: optionalString(row.target_chat_id),
    target_thread_id: optionalString(row.target_thread_id), target_message_id: optionalString(row.target_message_id),
    content: requiredString(row.content, "im_reply_drafts.content"), status: requiredString(row.status, "im_reply_drafts.status"),
    risk: requiredString(row.risk, "im_reply_drafts.risk"), created_by: requiredString(row.created_by, "im_reply_drafts.created_by"),
    approval_action_id: optionalString(row.approval_action_id), rejection_reason: optionalString(row.rejection_reason),
    created_at: requiredString(row.created_at, "im_reply_drafts.created_at"),
    updated_at: requiredString(row.updated_at, "im_reply_drafts.updated_at")
  };
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
    correlation_id: optionalString(row.correlation_id),
    dedupe_key: optionalString(row.dedupe_key),
    feishu_message_id: optionalString(row.feishu_message_id),
    last_error: optionalString(row.last_error),
    provider_request_ref: optionalString(row.provider_request_ref),
    result_json: optionalString(row.result_json),
    max_attempts: integerRow(row.max_attempts, "sync_outbox.max_attempts"),
    operation_kind: optionalString(row.operation_kind) || "im_reply",
    payload_json: optionalString(row.payload_json),
    retry_after_seconds: integerRow(row.retry_after_seconds, "sync_outbox.retry_after_seconds"),
    sent_at: optionalString(row.sent_at),
    created_at: requiredString(row.created_at, "sync_outbox.created_at"),
    updated_at: requiredString(row.updated_at, "sync_outbox.updated_at")
  };
}

function mustGetImReplyDraft(db: RunnerDatabase, id: number): ImReplyDraftRecord {
  const draft = getImReplyDraft(db, id);
  if (!draft) throw new Error("im reply draft missing after write");
  return draft;
}

function mustGetSyncOutboxByDraft(db: RunnerDatabase, draftID: number): SyncOutboxRecord {
  const row = db.sqlite.query<Record<string, unknown>, [number]>(
    `select ${OUTBOX_COLUMNS} from sync_outbox where reply_draft_id=?`
  ).get(draftID);
  if (!row) throw new Error("sync outbox missing after write");
  return mapOutbox(row);
}

function outboxInsertColumns(): string {
  return `source, reply_draft_id, external_event_id, issue_id, target_chat_id,
    target_thread_id, target_message_id, content, status, risk, created_by,
    approval_action_id, created_at, updated_at`;
}

function draftInsertColumns(): string {
  return `source, external_event_id, issue_id, target_chat_id, target_thread_id,
    target_message_id, content, status, risk, created_by, approval_action_id,
    rejection_reason, created_at, updated_at`;
}

function lastInsertID(db: RunnerDatabase): number {
  return db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0;
}
