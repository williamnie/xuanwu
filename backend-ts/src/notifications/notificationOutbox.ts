import type { RunnerDatabase } from "../db/database.ts";
import { createExternalLink, listExternalLinksByExternal } from "../db/repositories/externalLinks.ts";
import {
  approveImReplyDraft,
  createImReplyDraft
} from "../db/repositories/imReplyOutbox.ts";
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

// The production delivery authority for `operation_kind='im_reply'` rows is
// the registry-driven `dispatchImOutbox` in pi/imReplyOutboxDispatcher.ts.
// There is intentionally no second channel-sender dispatcher here: outbox
// rows claim/send/receipt exactly once through the generic dispatcher.

/**
 * sync_outbox remains the only external-delivery authority. The source column is
 * the channel route. Unified notification producers use the same im_reply
 * draft/outbox rows, while historical Feishu links remain valid dedupe facts.
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
