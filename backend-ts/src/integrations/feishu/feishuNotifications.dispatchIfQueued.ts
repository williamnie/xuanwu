import type { RunnerDatabase } from "../../db/database.ts";
import { getIssue } from "../../db/repositories/issues.ts";
import { latestCompletedEnqueueAction } from "../../db/repositories/pi/actions.ts";
import { getPiAction, createPiNotificationIntent } from "../../db/repositories/pi.ts";
import type { AppEvent } from "../../events/bus.ts";
import type { FeishuConnectorConfig } from "./feishu.ts";
import { createFeishuMessageClient } from "./feishuClient.ts";
import { dispatchFeishuOutbox, type FeishuMessageSender } from "./feishuOutboxDispatcherCompat.ts";
import type { ImChannelRegistry } from "../im/imChannelContracts.ts";
import type { ChannelConnector } from "../channelConnectorContracts.ts";
import { dispatchImOutbox } from "../../pi/notifications/imReplyOutboxDispatcher.ts";
import { routeNotification } from "../../notifications/unifiedNotificationPipeline.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import { resolveImNotificationConnectorID, resolveImNotificationTarget } from "../im/imNotificationTargets.ts";
import { type QueueResult } from "./feishuLifecycleNotifications.ts";
import type { NotificationTarget } from "./feishuNotifications.model.ts";

export const APPROVAL_NOTIFY_TYPE = "feishu_approval_notification";

export const PI_ACTION_NOTIFY_TYPE = "feishu_pi_action_pending_notification";

export const PI_NEEDS_USER_NOTIFY_TYPE = "feishu_pi_needs_user_notification";

export function dispatchIfQueued(input: {
  config?: FeishuConnectorConfig;
  database: RunnerDatabase;
  imChannels?: ImChannelRegistry;
  connector?: ChannelConnector;
  sender?: FeishuMessageSender;
}, result: QueueResult): void {
  if (!result.queued) return;
  if (input.imChannels) {
    void dispatchImOutbox({
      database: input.database,
      resolveConnector: (source) => input.imChannels!.get(source).connector
    }).catch(() => {});
    return;
  }
  if (input.connector) {
    void dispatchImOutbox({
      database: input.database,
      source: input.connector.manifest.id,
      resolveConnector: (source) => {
        if (source !== input.connector!.manifest.id) throw new Error(`im channel module is not registered: ${source}`);
        return input.connector!;
      }
    }).catch(() => {});
    return;
  }
  if (!input.config) return;
  const sender = input.sender ?? createFeishuMessageClient({ config: input.config });
  void dispatchFeishuOutbox({ config: input.config, database: input.database, sender }).catch(() => {});
}

export function piActionNotificationDetail(payloadJSON: string | undefined): string {
  if (!payloadJSON) return "";
  const payload = parseObject(payloadJSON);
  const provider = safeText(payload.provider_id);
  const tool = safeText(payload.tool_name);
  const capability = safeText(payload.capability_id);
  const permission = safeText(payload.permission);
  const target = provider && tool ? `${provider}:${tool}` : capability;
  const input = parseObject(payload.input);
  const inputText = Object.keys(input).length > 0 ? redactSensitiveText(JSON.stringify(input)) : "";
  return [target ? `目标 ${target}` : "", permission ? `权限 ${permission}` : "", inputText ? `输入 ${inputText}` : ""]
    .filter(Boolean)
    .join("；");
}

export function recordUnroutablePiActionNotification(db: RunnerDatabase, input: {
  actionID: string;
  actionType: string;
  conversationID: string;
  issueID: number;
  projectID: string;
}): void {
  createPiNotificationIntent(db, {
    conversation_id: input.conversationID,
    decision: "send_now",
    error: "missing_feishu_target",
    idempotency_key: `pi_action_pending:${input.actionID}:feishu`,
    issue_id: input.issueID,
    kind: "pi_action_pending",
    payload_json: {
      action_id: input.actionID,
      action_type: input.actionType,
      issue_id: input.issueID
    },
    project_id: input.projectID,
    requires_user: 1,
    severity: "actionable",
    source_event_id: input.actionID,
    source_event_type: "pi.action_pending",
    state: "failed",
    summary: `PI action ${input.actionID} pending approval; Feishu target missing`,
    target_channel: "feishu"
  });
}

export function providerTarget(
  connectorID: string,
  target: { chatID: string; eventID: number; messageID: string; threadID: string } | null | undefined
): NotificationTarget | null {
  return target ? { connectorID, ...target } : null;
}

export function resolveGenericTarget(db: RunnerDatabase, input: {
  conversationID?: string;
  issueID?: number;
  projectID?: string;
}): NotificationTarget | null {
  const connectorID = resolveImNotificationConnectorID(db, input);
  if (connectorID === "") return null;
  const target = resolveImNotificationTarget(db, { connectorID, ...input });
  return target ? {
    chatID: target.conversation_id,
    connectorID: target.connector_id,
    eventID: target.external_event_id,
    messageID: target.reply_to_message_id ?? "",
    threadID: target.thread_id ?? ""
  } : null;
}

export function notificationRoute(target: NotificationTarget) {
  return {
    channel: target.connectorID,
    chatID: target.chatID,
    eventID: target.eventID,
    messageID: target.messageID,
    threadID: target.threadID
  };
}

export function queueResult(result: ReturnType<typeof routeNotification>[number] | undefined): QueueResult {
  return result?.queued
    ? { queued: true, reason: "queued" }
    : { queued: false, reason: result?.reason || "duplicate" };
}

export function isPiIssueStartEvent(db: RunnerDatabase, event: AppEvent): boolean {
  if (event.type !== "pi.action_completed" || !event.issueId) return false;
  const payload = parseObject(event.payload);
  if (safeText(payload.action_type) !== "issue.enqueue") return false;
  return !isRunnerChatEnqueueAction(db, payload);
}

export function shouldSuppressLifecycleStartNotification(db: RunnerDatabase, issueID: number): boolean {
  const issue = getIssue(db, issueID);
  if (!issue || !["todo", "in_progress"].includes(issue.status)) return false;
  if (hasRunGroupMembership(db, issue.id)) return false;
  const action = latestCompletedEnqueueAction(db, issue.id);
  return action ? isRunnerChatSource(action.source) : false;
}

export function hasRunGroupMembership(db: RunnerDatabase, issueID: number): boolean {
  const row = db.sqlite.query<{ count: number }, [number]>(
    "select count(*) as count from pi_run_group_items where issue_id=?"
  ).get(issueID);
  return (row?.count ?? 0) > 0;
}

export function isRunnerChatEnqueueAction(db: RunnerDatabase, payload: Record<string, unknown>): boolean {
  const actionID = safeText(payload.action_id);
  const source = actionID ? getPiAction(db, actionID)?.source : safeText(payload.source);
  return isRunnerChatSource(source);
}

export function isRunnerChatSource(value: unknown): boolean {
  const source = safeText(value);
  return source === "feishu_runner_chat" || source === "runner_chat";
}

export function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function safeText(value: unknown): string {
  return typeof value === "string" ? redactSensitiveText(value).trim() : "";
}
