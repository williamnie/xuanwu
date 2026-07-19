import type { RunnerDatabase } from "../db/database.ts";
import {
  markPiIssueCompletionWatchSatisfied,
  listPiNotificationIntents,
  type PiNotificationIntent
} from "../db/repositories/pi.ts";
import { ISSUE_COMPLETION_WATCH_INTENT_KIND } from "../pi/issueCompletionWatchEvaluator.ts";
import {
  markNotificationIntentRetry
} from "../pi/notificationCoordinator.ts";
import { queueExistingNotificationIntent } from "../notifications/unifiedNotificationPipeline.ts";
import { formatIssueCompletionWatchNotification } from "./feishuNotificationFormatters.ts";

export type CompletionWatchQueueResult = {
  failed: number;
  queued: number;
  scanned: number;
  skipped: number;
};

const COMPLETION_WATCH_NOTIFY_TYPE = "feishu_issue_completion_watch_notification";
const DEFAULT_WATCH_LIMIT = 20;

export function queueReadyFeishuCompletionWatchNotifications(
  db: RunnerDatabase,
  options: { limit?: number } = {}
): CompletionWatchQueueResult {
  const intents = readyWatchIntents(db, options.limit ?? DEFAULT_WATCH_LIMIT);
  const result: CompletionWatchQueueResult = { failed: 0, queued: 0, scanned: intents.length, skipped: 0 };
  for (const intent of intents) safelyQueueWatchIntent(db, intent, result);
  return result;
}

function safelyQueueWatchIntent(
  db: RunnerDatabase,
  intent: PiNotificationIntent,
  result: CompletionWatchQueueResult
): void {
  try {
    queueWatchIntent(db, intent, result);
  } catch (error) {
    retryWatchIntent(db, intent, safeError(error));
    result.failed += 1;
  }
}

function queueWatchIntent(
  db: RunnerDatabase,
  intent: PiNotificationIntent,
  result: CompletionWatchQueueResult
): void {
  if (intent.target_channel !== "feishu" || intent.sent_outbox_id > 0) {
    result.skipped += 1;
    return;
  }
  const target = directTarget(intent);
  if (!target) {
    retryWatchIntent(db, intent, "missing_feishu_target");
    result.failed += 1;
    return;
  }
  const payload = parseRecord(intent.payload_json);
  const notifyID = watchNotificationID(intent, payload);
  const queued = queueExistingNotificationIntent(db, {
    content: formatIssueCompletionWatchNotification(payload),
    deepLink: intent.issue_id > 0 ? `/api/issues/${intent.issue_id}` : "#/automations",
    intent,
    notificationID: notifyID,
    notificationType: COMPLETION_WATCH_NOTIFY_TYPE,
    route: {
      channel: "feishu",
      chatID: target.chatID,
      eventID: target.eventID,
      messageID: target.messageID,
      threadID: target.threadID
    }
  });
  if (!queued.queued) {
    result.skipped += 1;
    return;
  }
  clearWatchError(db, payload);
  result.queued += 1;
}

function readyWatchIntents(db: RunnerDatabase, limit: number): PiNotificationIntent[] {
  return listPiNotificationIntents(db, { kind: ISSUE_COMPLETION_WATCH_INTENT_KIND, state: "ready" })
    .slice(0, boundedLimit(limit));
}

function directTarget(intent: PiNotificationIntent) {
  if (intent.target_chat_id === "" && intent.target_message_id === "") return null;
  return {
    chatID: intent.target_chat_id,
    eventID: 0,
    messageID: intent.target_message_id,
    threadID: intent.target_thread_id
  };
}

function watchNotificationID(intent: PiNotificationIntent, payload: Record<string, unknown>): string {
  return watchID(payload) || intent.idempotency_key || intent.id;
}

function watchID(payload: Record<string, unknown>): string {
  return cleanString(payload.watch_id);
}

function retryWatchIntent(db: RunnerDatabase, intent: PiNotificationIntent, reason: string): void {
  const safe = safeError(reason);
  markNotificationIntentRetry(db, intent, safe);
  const id = watchID(parseRecord(intent.payload_json));
  if (id !== "") markPiIssueCompletionWatchSatisfied(db, id, safe);
}

function clearWatchError(db: RunnerDatabase, payload: Record<string, unknown>): void {
  const id = watchID(payload);
  if (id !== "") markPiIssueCompletionWatchSatisfied(db, id, "");
}

function boundedLimit(limit: number): number {
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, DEFAULT_WATCH_LIMIT) : DEFAULT_WATCH_LIMIT;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
