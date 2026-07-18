import type { RunnerDatabase } from "../db/database.ts";
import { createExternalLink, listExternalLinksByExternal } from "../db/repositories/externalLinks.ts";
import {
  approveImReplyDraft,
  createImReplyDraft,
  getImReplyDraft,
  type SyncOutboxRecord
} from "../db/repositories/imReplyOutbox.ts";
import {
  claimSyncOutboxSending,
  listDispatchableSyncOutbox,
  markSyncOutboxFailed,
  markSyncOutboxRetry,
  markSyncOutboxSent
} from "../db/repositories/imReplyOutboxDispatch.ts";
import { redactSensitiveText } from "../util/redact.ts";

export type NotificationOutboxTarget = {
  chatID?: string;
  eventID?: number;
  messageID?: string;
  threadID?: string;
};

export type QueueNotificationOutboxInput = {
  approvalActionID?: string;
  channel: string;
  content: string;
  createdBy?: string;
  issueID?: number;
  notificationID: string;
  notificationType: string;
  projectID?: string;
  target: NotificationOutboxTarget;
};

export type QueueNotificationOutboxResult = {
  outboxID: number;
  queued: boolean;
  reason: "duplicate" | "queued";
};

export type NotificationChannelSendInput = {
  approvalActionID: string;
  channel: string;
  content: string;
  idempotencyKey: string;
  issueID: number;
  outboxID: number;
  target: NotificationOutboxTarget;
};

export type NotificationChannelSender = {
  send(input: NotificationChannelSendInput): Promise<{ deliveryID: string }>;
};

export class NotificationChannelError extends Error {
  readonly retryAfterSeconds?: number;
  readonly retryable: boolean;

  constructor(message: string, options: { retryAfterSeconds?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = "NotificationChannelError";
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.retryable = options.retryable !== false;
  }
}

export type NotificationOutboxDispatchResult = {
  failed: number;
  processed: number;
  retry: number;
  sent: number;
  skipped: number;
};

/**
 * sync_outbox remains the only external-delivery authority. The source column is
 * the channel route during the W1 compatibility window; legacy Feishu callers
 * still use the same im_reply draft/outbox rows through their thin wrapper.
 */
export function queueNotificationOutbox(
  db: RunnerDatabase,
  input: QueueNotificationOutboxInput
): QueueNotificationOutboxResult {
  const record = normalizeQueueInput(input);
  return db.transaction(() => {
    if (alreadyQueuedNotification(db, record.channel, record.notificationType, record.notificationID)) {
      return { outboxID: 0, queued: false, reason: "duplicate" as const };
    }
    const draft = createImReplyDraft(db, {
      approval_action_id: record.approvalActionID,
      content: record.content,
      created_by: record.createdBy,
      external_event_id: record.target.eventID,
      issue_id: record.issueID,
      risk: "low",
      source: record.channel,
      status: "pending",
      target_chat_id: record.target.chatID,
      target_message_id: record.target.messageID,
      target_thread_id: record.target.threadID
    });
    const approved = approveImReplyDraft(db, draft.id);
    createExternalLink(db, {
      conversation_id: record.target.threadID || record.target.chatID,
      external_event_id: record.target.eventID,
      external_id: record.notificationID,
      external_type: record.notificationType,
      issue_id: record.issueID,
      project_id: record.projectID,
      relationship: "notification",
      source: record.channel
    });
    return { outboxID: approved.outbox.id, queued: true, reason: "queued" as const };
  }).immediate();
}

export function alreadyQueuedNotification(
  db: RunnerDatabase,
  channel: string,
  notificationType: string,
  notificationID: string
): boolean {
  return listExternalLinksByExternal(db, {
    externalID: cleanString(notificationID),
    externalType: cleanString(notificationType),
    limit: 1,
    source: cleanString(channel)
  }).length > 0;
}

/**
 * Channel-neutral fixture/runtime dispatcher. Production Feishu continues to
 * use its card-aware dispatcher; additional channels can share retry/dedupe
 * semantics without adding another outbox.
 */
export async function dispatchNotificationOutbox(input: {
  database: RunnerDatabase;
  limit?: number;
  now?: Date;
  senders: Record<string, NotificationChannelSender>;
}): Promise<NotificationOutboxDispatchResult> {
  const result = emptyDispatchResult();
  const now = input.now ?? new Date();
  const channels = Object.keys(input.senders).map(cleanString).filter(Boolean).sort();
  for (const channel of channels) {
    const candidates = listDispatchableSyncOutbox(input.database, {
      limit: input.limit,
      now,
      source: channel
    });
    for (const candidate of candidates) {
      const claimed = claimSyncOutboxSending(input.database, candidate.id, now);
      if (!claimed) {
        result.skipped += 1;
        continue;
      }
      await dispatchOne(input.database, claimed, channel, input.senders[channel]!, now, result);
    }
  }
  return result;
}

async function dispatchOne(
  db: RunnerDatabase,
  outbox: SyncOutboxRecord,
  channel: string,
  sender: NotificationChannelSender,
  now: Date,
  result: NotificationOutboxDispatchResult
): Promise<void> {
  result.processed += 1;
  const policyError = deliveryPolicyError(db, outbox, channel);
  if (policyError !== "") {
    markSyncOutboxFailed(db, outbox.id, { error: policyError, timestamp: now });
    result.failed += 1;
    return;
  }
  try {
    const delivery = await sender.send({
      approvalActionID: outbox.approval_action_id,
      channel,
      content: outbox.content,
      idempotencyKey: `sync_outbox:${outbox.id}`,
      issueID: outbox.issue_id,
      outboxID: outbox.id,
      target: {
        chatID: outbox.target_chat_id,
        messageID: outbox.target_message_id,
        threadID: outbox.target_thread_id
      }
    });
    markSyncOutboxSent(db, outbox.id, {
      // Compatibility carrier: this column is the provider delivery receipt for
      // im_reply rows until the P09 connector cutover, not Feishu authority.
      feishuMessageId: requiredText(delivery.deliveryID, "deliveryID"),
      timestamp: now
    });
    result.sent += 1;
  } catch (error) {
    const channelError = error instanceof NotificationChannelError ? error : null;
    if (channelError && !channelError.retryable) {
      markSyncOutboxFailed(db, outbox.id, { error: safeError(error), timestamp: now });
      result.failed += 1;
      return;
    }
    const next = markSyncOutboxRetry(db, outbox.id, {
      error: safeError(error),
      retryAfterSeconds: channelError?.retryAfterSeconds,
      timestamp: now
    });
    if (next.status === "failed") result.failed += 1;
    else result.retry += 1;
  }
}

function deliveryPolicyError(db: RunnerDatabase, outbox: SyncOutboxRecord, channel: string): string {
  if (outbox.source !== channel) return `outbox source does not match channel ${channel}`;
  if (outbox.status !== "sending") return `outbox is not claimed for sending: ${outbox.status}`;
  if (getImReplyDraft(db, outbox.reply_draft_id)?.status !== "approved") return "reply draft is not approved";
  if (outbox.feishu_message_id !== "") return "outbox already has delivery receipt";
  if (outbox.content.trim() === "") return "outbox content is empty";
  if (outbox.risk !== "low") return `outbox risk is not allowed: ${outbox.risk}`;
  if (outbox.target_chat_id === "" && outbox.target_thread_id === "" && outbox.target_message_id === "") {
    return "outbox target is empty";
  }
  return "";
}

function normalizeQueueInput(input: QueueNotificationOutboxInput) {
  const target = {
    chatID: cleanString(input.target.chatID),
    eventID: positiveInteger(input.target.eventID),
    messageID: cleanString(input.target.messageID),
    threadID: cleanString(input.target.threadID)
  };
  if (target.chatID === "" && target.messageID === "" && target.threadID === "") {
    throw new Error("notification target is required");
  }
  return {
    approvalActionID: cleanString(input.approvalActionID),
    channel: requiredText(input.channel, "channel"),
    content: requiredText(redactSensitiveText(input.content), "content"),
    createdBy: cleanString(input.createdBy) || "notification_pipeline",
    issueID: positiveInteger(input.issueID),
    notificationID: requiredText(input.notificationID, "notificationID"),
    notificationType: requiredText(input.notificationType, "notificationType"),
    projectID: cleanString(input.projectID),
    target
  };
}

function emptyDispatchResult(): NotificationOutboxDispatchResult {
  return { failed: 0, processed: 0, retry: 0, sent: 0, skipped: 0 };
}

function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

function requiredText(value: unknown, label: string): string {
  const text = cleanString(value);
  if (text === "") throw new Error(`${label} is required`);
  return text;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}
