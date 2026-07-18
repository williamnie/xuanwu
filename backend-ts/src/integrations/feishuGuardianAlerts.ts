import type { RunnerDatabase } from "../db/database.ts";
import {
  updatePiGuardianAlert,
  getPiRunGroup,
  type PiGuardianAlert
} from "../db/repositories/pi.ts";
import { redactAuditText } from "../db/repositories/pi/auditRedaction.ts";
import { SUPERVISOR_NOTIFICATION_PREFIX } from "../xuanwu/userFacingTerminology.ts";
import {
  failedGuardianAlertRetryPatch,
  sentGuardianAlertRetryPatch,
  shouldAttemptGuardianAlertFeishu
} from "../pi/guardianAlertRetryPolicy.ts";
import type { FeishuConnectorConfig } from "./feishu.ts";
import {
  createFeishuMessageClient,
  FeishuClientError,
  type FeishuMessageClient
} from "./feishuClient.ts";
import { createFeishuChannelConnector, createFeishuOutboundEnvelope } from "./feishuChannelConnector.ts";
import { feishuTargetForConversation, feishuTargetForIssue } from "./feishuNotificationTargets.ts";

export type PiGuardianDirectFeishuOptions = {
  config: FeishuConnectorConfig;
  formatText?: (alert: PiGuardianAlert) => string;
  now?: Date;
  sender?: FeishuMessageClient;
};

type SendTarget = { receiveId: string; receiveIdType: string };

const DEFAULT_RETRY_SECONDS = 60;

export async function sendDirectFeishuGuardianAlert(
  db: RunnerDatabase,
  alert: PiGuardianAlert,
  options: PiGuardianDirectFeishuOptions
): Promise<void> {
  if (!shouldAttemptGuardianAlertFeishu(alert, options.now ?? new Date())) return;
  const target = resolveTarget(db, alert, options.config);
  if (!target) return recordFailure(db, alert, "missing direct Feishu target", options.now);
  if (!targetAllowed(options.config, target)) {
    return recordFailure(db, alert, `${target.receiveIdType} is not allowed`, options.now, true);
  }
  try {
    const sender = options.sender ?? createFeishuMessageClient({ config: options.config });
    const alertRef = `pi_guardian_alerts:${alert.id}`;
    const receipt = await createFeishuChannelConnector({ config: options.config, sender }).deliver!(createFeishuOutboundEnvelope({
      actionGateRef: `${alertRef}:retry-policy`,
      actionID: `${alertRef}:direct-feishu`,
      authority: "deterministic_policy",
      correlationID: alert.run_group_id || alertRef,
      eventRef: alertRef,
      idempotencyKey: `${alertRef}:direct-feishu`,
      occurredAt: options.now?.toISOString(),
      operation: "message.reply",
      payload: { text: alertText(alert, options) },
      receiveID: target.receiveId,
      receiveIDType: target.receiveIdType
    }));
    updatePiGuardianAlert(db, alert.id, sentGuardianAlertRetryPatch({
      alert,
      messageId: receipt.provider_request_ref,
      now: options.now
    }));
  } catch (error) {
    recordFailure(db, alert, safeError(error), options.now, permanentError(error), retryAfter(error));
  }
}

function resolveTarget(
  db: RunnerDatabase,
  alert: PiGuardianAlert,
  config: FeishuConnectorConfig
): SendTarget | null {
  if (alert.issue_id > 0) {
    const issueTarget = feishuTargetForIssue(db, alert.issue_id);
    if (issueTarget?.chatID) return { receiveId: issueTarget.chatID, receiveIdType: "chat_id" };
  }
  const conversationTarget = runGroupConversationTarget(db, alert);
  if (conversationTarget) return conversationTarget;
  const mapping = config.projectMappings.find((item) => item.projectId === alert.project_id);
  if (mapping?.chatId) return { receiveId: mapping.chatId, receiveIdType: "chat_id" };
  if (mapping?.userId) return { receiveId: mapping.userId, receiveIdType: userReceiveType(mapping.userId) };
  if (config.defaultChatId) return { receiveId: config.defaultChatId, receiveIdType: "chat_id" };
  if (config.defaultUserId) return { receiveId: config.defaultUserId, receiveIdType: userReceiveType(config.defaultUserId) };
  return null;
}

function runGroupConversationTarget(db: RunnerDatabase, alert: PiGuardianAlert): SendTarget | null {
  const conversationID = getPiRunGroup(db, alert.run_group_id)?.origin_conversation_id ?? "";
  const target = feishuTargetForConversation(db, conversationID);
  return target?.chatID ? { receiveId: target.chatID, receiveIdType: "chat_id" } : null;
}

function recordFailure(
  db: RunnerDatabase,
  alert: PiGuardianAlert,
  error: string,
  now = new Date(),
  permanent = false,
  retryAfterSeconds = DEFAULT_RETRY_SECONDS
): void {
  updatePiGuardianAlert(db, alert.id, {
    direct_feishu_error: redactAuditText(error),
    ...failedGuardianAlertRetryPatch({ alert, now, permanent, retryAfterSeconds })
  });
}

function directText(alert: PiGuardianAlert): string {
  return [
    `[${SUPERVISOR_NOTIFICATION_PREFIX} · Guardian watchdog]`,
    `alert=${field(alert.alert_type)}`,
    `severity=${field(alert.severity)}`,
    `project=${field(alert.project_id)}`,
    `issue=${alert.issue_id > 0 ? alert.issue_id : "-"}`,
    `run_group=${field(alert.run_group_id)}`,
    `message=${oneLine(alert.message)}`,
    `seen_at=${field(alert.watchdog_seen_at)}`
  ].join("\n");
}

function targetAllowed(config: FeishuConnectorConfig, target: SendTarget): boolean {
  if (target.receiveIdType === "chat_id") return allowed(config.allowedChatIds, target.receiveId);
  if (["open_id", "user_id", "union_id"].includes(target.receiveIdType)) {
    return allowed(config.allowedUserIds, target.receiveId);
  }
  return true;
}

function alertText(alert: PiGuardianAlert, options: PiGuardianDirectFeishuOptions): string {
  return options.formatText?.(alert) ?? directText(alert);
}

function allowed(values: string[], value: string): boolean {
  return values.length === 0 || values.includes(value);
}

function userReceiveType(value: string): string {
  if (value.startsWith("ou_")) return "open_id";
  if (value.startsWith("on_")) return "union_id";
  if (value.includes("@")) return "email";
  return "user_id";
}

function permanentError(error: unknown): boolean {
  return error instanceof FeishuClientError && (error.kind === "auth" || error.kind === "permanent");
}

function retryAfter(error: unknown): number {
  const seconds = error instanceof FeishuClientError ? error.retryAfterSeconds : undefined;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? Math.ceil(seconds)
    : DEFAULT_RETRY_SECONDS;
}

function safeError(error: unknown): string {
  return redactAuditText(error instanceof Error ? error.message : String(error));
}

function field(value: string): string {
  const text = oneLine(value);
  return text === "" ? "-" : text;
}

function oneLine(value: string): string {
  return redactAuditText(value).replace(/\s+/g, " ").trim();
}
