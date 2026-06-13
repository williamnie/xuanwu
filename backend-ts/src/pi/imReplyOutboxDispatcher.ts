import type { RunnerDatabase } from "../db/database.ts";
import { getImReplyDraft, type SyncOutboxRecord } from "../db/repositories/imReplyOutbox.ts";
import {
  claimSyncOutboxSending,
  listDispatchableSyncOutbox,
  markSyncOutboxFailed,
  markSyncOutboxRetry,
  markSyncOutboxSent
} from "../db/repositories/imReplyOutboxDispatch.ts";
import { getPiApprovalRequest } from "../db/repositories/pi.ts";
import { buildFeishuApprovalCard } from "../integrations/feishuApprovalCards.ts";
import type { FeishuConnectorConfig } from "../integrations/feishu.ts";
import { FeishuClientError, type FeishuMessageClient } from "../integrations/feishuClient.ts";
import { redactSensitiveText } from "../util/redact.ts";

export type FeishuMessageSender = FeishuMessageClient;
export type FeishuOutboxDispatchResult = {
  failed: number;
  processed: number;
  retry: number;
  sent: number;
  skipped: number;
};

export type FeishuOutboxDispatchOptions = {
  config: FeishuConnectorConfig;
  database: RunnerDatabase;
  limit?: number;
  now?: Date;
  sender: FeishuMessageSender;
};

type SendTarget = { receiveId: string; receiveIdType: string };

export async function dispatchFeishuOutbox(options: FeishuOutboxDispatchOptions): Promise<FeishuOutboxDispatchResult> {
  const now = options.now ?? new Date();
  const result = emptyResult();
  const candidates = listDispatchableSyncOutbox(options.database, { limit: options.limit, now, source: "feishu" });
  for (const candidate of candidates) {
    const claimed = claimSyncOutboxSending(options.database, candidate.id, now);
    if (!claimed) {
      result.skipped += 1;
      continue;
    }
    await sendOne(options, claimed, now, result);
  }
  return result;
}

async function sendOne(
  options: FeishuOutboxDispatchOptions,
  outbox: SyncOutboxRecord,
  now: Date,
  result: FeishuOutboxDispatchResult
): Promise<void> {
  result.processed += 1;
  const policy = preflightPolicy(options.database, outbox, options.config);
  if (policy) return fail(options.database, outbox, policy, now, result);
  try {
    const sent = await sendFeishuMessage(options, outbox);
    markSyncOutboxSent(options.database, outbox.id, { feishuMessageId: sent.messageId, timestamp: now });
    result.sent += 1;
  } catch (error) {
    handleSendError(options.database, outbox, error, now, result);
  }
}

async function sendFeishuMessage(
  options: FeishuOutboxDispatchOptions,
  outbox: SyncOutboxRecord
): Promise<{ messageId: string }> {
  const target = sendTarget(outbox);
  const approvalID = approvalRequestID(outbox);
  const approval = approvalID ? getPiApprovalRequest(options.database, approvalID) : null;
  if (approval && options.sender.sendInteractiveCard) {
    return await options.sender.sendInteractiveCard({
      ...target,
      card: buildFeishuApprovalCard({
        approvalID: approval.approval_id,
        issueID: approval.issue_id || outbox.issue_id,
        text: outbox.content
      })
    });
  }
  return await options.sender.sendTextMessage({ ...target, text: outbox.content });
}

function handleSendError(
  db: RunnerDatabase,
  outbox: SyncOutboxRecord,
  error: unknown,
  now: Date,
  result: FeishuOutboxDispatchResult
): void {
  const summary = safeError(error);
  if (error instanceof FeishuClientError && (error.kind === "auth" || error.kind === "permanent")) {
    return fail(db, outbox, summary, now, result);
  }
  const retryAfter = error instanceof FeishuClientError ? error.retryAfterSeconds : undefined;
  const next = markSyncOutboxRetry(db, outbox.id, { error: summary, retryAfterSeconds: retryAfter, timestamp: now });
  if (next.status === "failed") result.failed += 1;
  else result.retry += 1;
}

function fail(
  db: RunnerDatabase,
  outbox: SyncOutboxRecord,
  error: string,
  now: Date,
  result: FeishuOutboxDispatchResult
): void {
  markSyncOutboxFailed(db, outbox.id, { error, timestamp: now });
  result.failed += 1;
}

function preflightPolicy(db: RunnerDatabase, outbox: SyncOutboxRecord, config: FeishuConnectorConfig): string {
  if (outbox.source !== "feishu") return "outbox source is not feishu";
  if (outbox.status !== "sending") return `outbox is not claimed for sending: ${outbox.status}`;
  if (getImReplyDraft(db, outbox.reply_draft_id)?.status !== "approved") return "reply draft is not approved";
  if (outbox.feishu_message_id !== "") return "outbox already has Feishu message id";
  if (outbox.content.trim() === "") return "outbox content is empty";
  if (outbox.risk !== "low") return `outbox risk is not allowed: ${outbox.risk}`;
  const approval = approvalRequestID(outbox);
  if (approval !== "" && !getPiApprovalRequest(db, approval)) return "approval request is missing";
  const target = sendTarget(outbox);
  if (target.receiveId === "") return "outbox receive id is empty";
  if (!targetAllowed(config, target)) return `${target.receiveIdType.replace("_id", "")} is not allowed: ${target.receiveId}`;
  return "";
}

function approvalRequestID(outbox: SyncOutboxRecord): string {
  return outbox.approval_action_id.trim();
}

function targetAllowed(config: FeishuConnectorConfig, target: SendTarget): boolean {
  if (target.receiveIdType === "chat_id") return allowed(config.allowedChatIds, target.receiveId);
  if (target.receiveIdType === "open_id" || target.receiveIdType === "user_id") {
    return allowed(config.allowedUserIds, target.receiveId);
  }
  return false;
}

function allowed(values: string[], value: string): boolean {
  return values.length === 0 || values.includes(value);
}

function sendTarget(outbox: SyncOutboxRecord): SendTarget {
  const receiveId = outbox.target_chat_id || outbox.target_thread_id || outbox.target_message_id;
  return { receiveId, receiveIdType: receiveIdType(receiveId) };
}

function receiveIdType(receiveId: string): string {
  if (receiveId.startsWith("oc_")) return "chat_id";
  if (receiveId.startsWith("ou_")) return "open_id";
  if (receiveId.startsWith("on_")) return "union_id";
  return "chat_id";
}

function emptyResult(): FeishuOutboxDispatchResult {
  return { failed: 0, processed: 0, retry: 0, sent: 0, skipped: 0 };
}

function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}
