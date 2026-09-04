import type { RunnerDatabase } from "../db/database.ts";
import { getPiRunGroup, type PiGuardianAlert } from "../db/repositories/pi.ts";
import { getSyncOutbox } from "../db/repositories/imReplyOutbox.ts";
import { queueNotificationOutbox } from "../notifications/notificationOutbox.ts";
import type { GuardianAlertDelivery } from "../pi/guardianAlertDelivery.ts";
import { guardianAlertPresentation } from "../pi/guardianAlertPresentation.ts";
import { formatGuardianAlertText } from "../pi/guardianAlertText.ts";
import { dispatchImOutbox } from "../pi/imReplyOutboxDispatcher.ts";
import type { ImChannelRegistry } from "./imChannelContracts.ts";
import {
  resolveImNotificationConnectorID,
  resolveImNotificationTarget,
  type ResolvedImNotificationTarget
} from "./imNotificationTargets.ts";
import { telegramConnectorStatus } from "./telegramConfig.ts";
import type { TelegramConnectorConfig } from "./telegramTypes.ts";
import { notificationPresentation } from "../notifications/notificationPresentation.ts";

type Options = {
  database: RunnerDatabase;
  fallback?: GuardianAlertDelivery;
  feishuConfigured?: () => boolean;
  imChannels: ImChannelRegistry;
  telegramConfig?: () => TelegramConnectorConfig;
};

const NOTIFICATION_TYPE = "guardian_alert_notification";

/**
 * Routes Guardian's deterministic user escalation through the same durable IM
 * outbox as notifications. Shared origin facts win; an explicit Telegram
 * project mapping is next. Existing Feishu direct delivery remains the final
 * compatibility fallback for legacy/default-user targets.
 */
export function createImGuardianAlertDelivery(options: Options): GuardianAlertDelivery {
  return {
    connectorID: "im",
    send: async (alert, deliveryOptions = {}) => {
      const now = deliveryOptions.now ?? new Date();
      if (!guardianAlertPresentation(alert, now).requires_user) return;
      const target = linkedTarget(options.database, alert) ?? telegramFallback(options, alert);
      if (!target) return options.fallback?.send(alert, deliveryOptions);
      const content = deliveryOptions.formatText?.(alert) ?? formatGuardianAlertText(
        alert,
        now,
        guardianAlertPresentation(alert, now),
        notificationPresentation(options.database)
      );
      const queued = queueNotificationOutbox(options.database, {
        channel: target.connector_id,
        content,
        createdBy: "guardian_watchdog",
        issueID: alert.issue_id,
        notificationID: alert.id,
        notificationType: NOTIFICATION_TYPE,
        projectID: alert.project_id,
        target: {
          chatID: target.conversation_id,
          eventID: target.external_event_id,
          messageID: target.reply_to_message_id,
          threadID: target.thread_id
        }
      });
      const result = await dispatchImOutbox({
        database: options.database,
        ...(queued.outboxID > 0 ? { outboxId: queued.outboxID } : { source: target.connector_id }),
        now,
        resolveConnector: (source) => options.imChannels.get(source).connector
      });
      if (queued.outboxID > 0) {
        const outbox = getSyncOutbox(options.database, queued.outboxID);
        if (!outbox || outbox.status !== "sent") {
          throw new Error(outbox?.last_error || `Guardian IM delivery did not reach sent state: ${result.sent}`);
        }
      }
    }
  };
}

function linkedTarget(db: RunnerDatabase, alert: PiGuardianAlert): ResolvedImNotificationTarget | null {
  const conversationID = getPiRunGroup(db, alert.run_group_id)?.origin_conversation_id ?? "";
  const connectorID = resolveImNotificationConnectorID(db, {
    conversationID,
    issueID: alert.issue_id,
    projectID: alert.project_id
  });
  return connectorID === "" ? null : resolveImNotificationTarget(db, {
    connectorID,
    conversationID,
    issueID: alert.issue_id,
    projectID: alert.project_id
  });
}

function telegramFallback(options: Options, alert: PiGuardianAlert): ResolvedImNotificationTarget | null {
  const config = options.telegramConfig?.();
  if (!config || !telegramConnectorStatus(config).enabled) return null;
  const mapping = config.projectMappings.find((item) => item.projectId === alert.project_id);
  const mappedChat = clean(mapping?.chatId) || clean(mapping?.userId);
  const useDefault = mappedChat === "" && options.feishuConfigured?.() !== true;
  const chatID = mappedChat || (useDefault ? clean(config.defaultChatId) : "");
  if (chatID === "" || !config.allowedChatIds.includes(chatID)) return null;
  return {
    connector_id: "telegram",
    conversation_id: chatID,
    external_event_id: 0
  };
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
