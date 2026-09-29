import type { RunnerDatabase } from "../db/database.ts";
import {
  listReadyPiDigestNotificationIntents,
  updatePiNotificationIntent,
  type PiNotificationIntent
} from "../db/repositories/pi.ts";
import { resolveImNotificationTarget } from "../integrations/imNotificationTargets.ts";
import { queueExistingNotificationIntent, type NotificationRoute } from "../notifications/unifiedNotificationPipeline.ts";
import { formatRunGroupDigest } from "./digestFormatter.ts";
import { markNotificationIntentRetry } from "./notificationCoordinator.ts";

export type DigestNotificationQueueResult = { failed: number; queued: number; scanned: number; skipped: number };
export type DigestNotificationQueueOptions = { limit?: number; now?: Date };
type DigestNotificationProjection = {
  channel?: string;
  missingRouteReason(intent: PiNotificationIntent): string;
  notificationType: string;
  resolveRoute(db: RunnerDatabase, intent: PiNotificationIntent): DigestNotificationRoute | null;
};
type DigestNotificationRoute = NotificationRoute & { chatID: string; messageID: string; threadID: string };

const DEFAULT_LIMIT = 20;
const SCAN_MULTIPLIER = 5;
const RETRY_AFTER_MS = 15 * 60_000;

/** Channel-neutral delivery projection for ready digest intents. */
export function queueReadyImDigestNotifications(
  db: RunnerDatabase,
  options: DigestNotificationQueueOptions = {}
): DigestNotificationQueueResult {
  return queueReadyDigestNotifications(db, {
    missingRouteReason: (intent) => intent.target_channel === "" ? "missing_im_channel" : "missing_im_target",
    notificationType: "run_group_digest_notification",
    resolveRoute
  }, options);
}

/** 共用有界扫描与退避，兼容入口只负责各自的路由投影。 */
export function queueReadyDigestNotifications(
  db: RunnerDatabase,
  projection: DigestNotificationProjection,
  options: DigestNotificationQueueOptions = {}
): DigestNotificationQueueResult {
  const now = options.now ?? new Date();
  const limit = boundedLimit(options.limit);
  const intents = listReadyPiDigestNotificationIntents(db, {
    channel: projection.channel, limit: limit * SCAN_MULTIPLIER, now
  });
  const result: DigestNotificationQueueResult = { failed: 0, queued: 0, scanned: 0, skipped: 0 };
  const retryAfterAt = new Date(now.getTime() + RETRY_AFTER_MS).toISOString();
  for (const intent of intents) {
    result.scanned += 1;
    queueOne(db, intent, result, retryAfterAt, projection);
    if (result.queued >= limit) break;
  }
  return result;
}

function queueOne(
  db: RunnerDatabase, intent: PiNotificationIntent, result: DigestNotificationQueueResult,
  retryAfterAt: string, projection: DigestNotificationProjection
): void {
  if (intent.sent_outbox_id > 0) {
    result.skipped += 1;
    return;
  }
  try {
    const route = projection.resolveRoute(db, intent);
    if (!route) {
      markNotificationIntentRetry(db, intent, projection.missingRouteReason(intent), {
        retryAfterAt
      });
      result.failed += 1;
      return;
    }
    const routed = sameRoute(intent, route) ? intent : updatePiNotificationIntent(db, intent.id, {
      target_channel: route.channel,
      target_chat_id: route.chatID,
      target_message_id: route.messageID,
      target_thread_id: route.threadID
    });
    const queued = queueExistingNotificationIntent(db, {
      content: formatRunGroupDigest(routed),
      deepLink: `/api/pi/guardian/run-groups/${encodeURIComponent(routed.run_group_id)}`,
      intent: routed,
      notificationID: routed.idempotency_key || routed.id,
      notificationType: projection.notificationType,
      route
    });
    if (queued.queued) result.queued += 1;
    else result.skipped += 1;
  } catch (error) {
    markNotificationIntentRetry(db, intent, error instanceof Error ? error.message : String(error), { retryAfterAt });
    result.failed += 1;
  }
}

function resolveRoute(db: RunnerDatabase, intent: PiNotificationIntent) {
  if (intent.target_channel === "") return null;
  if (intent.target_chat_id !== "" || intent.target_message_id !== "" || intent.target_thread_id !== "") {
    return {
      channel: intent.target_channel,
      chatID: intent.target_chat_id,
      messageID: intent.target_message_id,
      threadID: intent.target_thread_id
    };
  }
  const target = resolveImNotificationTarget(db, {
    connectorID: intent.target_channel,
    conversationID: intent.conversation_id,
    projectID: intent.project_id
  });
  return target ? {
    channel: target.connector_id,
    chatID: target.conversation_id,
    eventID: target.external_event_id,
    messageID: target.reply_to_message_id ?? "",
    threadID: target.thread_id ?? ""
  } : null;
}

function sameRoute(intent: PiNotificationIntent, route: {
  channel: string; chatID: string; messageID: string; threadID: string;
}): boolean {
  return intent.target_channel === route.channel && intent.target_chat_id === route.chatID &&
    intent.target_message_id === route.messageID && intent.target_thread_id === route.threadID;
}

function boundedLimit(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, DEFAULT_LIMIT)
    : DEFAULT_LIMIT;
}
