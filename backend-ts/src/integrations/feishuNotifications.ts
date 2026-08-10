import type { RunnerDatabase } from "../db/database.ts";
import { getIssue, type Issue } from "../db/repositories/issues.ts";
import { listAgentSessions } from "../db/repositories/agentSessions.ts";
import {
  getPiAction,
  getPiApprovalRequest,
  createPiNotificationIntent,
  listPiActions,
  listPiApprovalRequests,
  listPiNotificationIntents,
  markPiApprovalDelivered,
  upsertPiApprovalRequest
} from "../db/repositories/pi.ts";
import type { AppEvent, EventBus } from "../events/bus.ts";
import type { FeishuConnectorConfig } from "./feishu.ts";
import { feishuConnectorStatus } from "./feishu.ts";
import { createFeishuMessageClient } from "./feishuClient.ts";
import {
  approvalRecordInput,
  parseCodexApprovalPayload,
  recordCodexApprovalResolved,
  resolvePiApprovalRequestFromFeishu
} from "./feishuApprovalRequests.ts";
import { dispatchFeishuOutbox, type FeishuMessageSender } from "./feishuOutboxDispatcherCompat.ts";
import type { ImChannelRegistry } from "./imChannelContracts.ts";
import type { ChannelConnector } from "./channelConnectorContracts.ts";
import { dispatchImOutbox } from "../pi/imReplyOutboxDispatcher.ts";
import { routeNotification } from "../notifications/unifiedNotificationPipeline.ts";
import { redactSensitiveText } from "../util/redact.ts";
import {
  formatApprovalNotification,
  formatPiActionPendingNotification,
  formatPiNeedsUserNotification
} from "./feishuNotificationFormatters.ts";
import { piActionApprovalActionID } from "./feishuPiActionCards.ts";
import {
  feishuFallbackTargetForProject,
  feishuTargetForConversation,
  feishuTargetForIssue
} from "./feishuNotificationTargets.ts";
import {
  queueFeishuIssueStatusNotification,
  type QueueResult
} from "./feishuLifecycleNotifications.ts";

const APPROVAL_NOTIFY_TYPE = "feishu_approval_notification";
const PI_ACTION_NOTIFY_TYPE = "feishu_pi_action_pending_notification";
const PI_NEEDS_USER_NOTIFY_TYPE = "feishu_pi_needs_user_notification";

export {
  getPiApprovalRequest,
  listPiApprovalRequests,
  queueFeishuIssueStatusNotification,
  resolvePiApprovalRequestFromFeishu
};

export function attachFeishuNotificationObservers(input: {
  bus: Pick<EventBus, "observe">;
  config?: FeishuConnectorConfig;
  database: RunnerDatabase;
  imChannels?: ImChannelRegistry;
  connector?: ChannelConnector;
  sender?: FeishuMessageSender;
}): () => void {
  return input.bus.observe((event) => {
    try {
      if ((event.type === "issue.status_changed" || event.type === "issue.created") && event.issueId) {
        const result = queueFeishuIssueStatusNotification(input.database, event.issueId, {
          config: input.config,
          eventType: event.type,
          suppressDirectStart: shouldSuppressLifecycleStartNotification(input.database, event.issueId)
        });
        dispatchIfQueued(input, result);
      }
      if (isPiIssueStartEvent(input.database, event)) {
        const result = queueFeishuIssueStatusNotification(input.database, event.issueId ?? 0, {
          config: input.config,
          conversationId: event.conversationId
        });
        dispatchIfQueued(input, result);
      }
      if (event.type === "pi.action_pending") {
        const result = queueFeishuPiActionPendingNotification(input.database, event, { config: input.config });
        dispatchIfQueued(input, result);
      }
      if (event.type === "pi.needs_user") {
        const result = queueFeishuPiNeedsUserNotification(input.database, event, { config: input.config });
        dispatchIfQueued(input, result);
      }
      if (event.type === "handoff.notification") {
        const result = queueFeishuHandoffNotification(input.database, event);
        dispatchIfQueued(input, result);
      }
      if (event.type === "codex.event" && event.method === "approval/requested") {
        const result = queueFeishuApprovalNotification(input.database, event, {
          config: input.config,
          requireConfigured: true
        });
        dispatchIfQueued(input, result);
      }
      if (event.type === "codex.event" && event.method === "approval/resolved") {
        recordCodexApprovalResolved(input.database, event);
      }
    } catch {
      // Notification writes are best-effort; the source runtime event should not fail.
    }
  });
}

function dispatchIfQueued(input: {
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

export function queueFeishuPiNeedsUserNotification(
  db: RunnerDatabase,
  event: AppEvent,
  options: { config?: FeishuConnectorConfig } = {}
): QueueResult {
  const payload = parseObject(event.payload);
  const issueID = event.issueId ?? positiveID(payload.issue_id);
  const notifyID = safeText(payload.action_id) || needsUserNotifyID(event, payload);
  if (notifyID === "") return { queued: false, reason: "missing_needs_user_id" };
  const issue = issueID > 0 ? getIssue(db, issueID) : null;
  const target = issue ? feishuTargetForIssue(db, issue.id) : null;
  const fallback = feishuTargetForConversation(db, safeText(event.conversationId));
  const projectID = issue?.project_id ?? safeText(event.projectId);
  const projectFallback = feishuFallbackTargetForProject(options.config, projectID);
  const finalTarget = target ?? fallback ?? projectFallback;
  if (!finalTarget) return { queued: false, reason: "missing_feishu_target" };
  const result = routeNotification(db, {
    content: formatPiNeedsUserNotification({
      diagnosis: safeText(payload.diagnosis) || safeText(payload.reason),
      issueID: issueID || undefined,
      message: safeText(payload.message) || safeText(event.text),
      nextStep: safeText(payload.next_step) || safeText(payload.nextStep),
      provider: safeText(payload.provider),
      userFacingMessage: safeText(payload.user_facing_message)
    }),
    conversationID: finalTarget.threadID || finalTarget.chatID,
    idempotencyKey: `pi_needs_user:${notifyID}`,
    issueID,
    kind: "pi_needs_user",
    notificationID: notifyID,
    notificationType: PI_NEEDS_USER_NOTIFY_TYPE,
    payload: {
      action_id: notifyID,
      issue_id: issueID,
      provider: safeText(payload.provider)
    },
    projectID,
    requiresUser: true,
    routes: [feishuRoute(finalTarget)],
    severity: "needs_user",
    sourceEventID: notifyID,
    sourceEventType: event.type,
    summary: `issue #${issueID || "unlinked"} needs user input`
  })[0];
  return queueResult(result);
}

export function queueFeishuPiActionPendingNotification(
  db: RunnerDatabase,
  event: AppEvent,
  options: { config?: FeishuConnectorConfig } = {}
): QueueResult {
  const payload = parseObject(event.payload);
  const actionID = safeText(payload.action_id);
  if (actionID === "") return { queued: false, reason: "missing_action_id" };
  const action = getPiAction(db, actionID);
  const issue = event.issueId ? getIssue(db, event.issueId) : null;
  const target = issue ? feishuTargetForIssue(db, issue.id) : null;
  const fallback = feishuTargetForConversation(db, safeText(event.conversationId));
  const issueID = issue?.id ?? event.issueId ?? 0;
  const projectID = issue?.project_id ?? safeText(event.projectId);
  const projectFallback = feishuFallbackTargetForProject(options.config, projectID);
  const finalTarget = target ?? fallback ?? projectFallback;
  if (!finalTarget) {
    recordUnroutablePiActionNotification(db, {
      actionID,
      actionType: safeText(payload.action_type),
      conversationID: safeText(event.conversationId),
      issueID,
      projectID
    });
    return { queued: false, reason: "missing_feishu_target" };
  }
  const result = routeNotification(db, {
    approvalActionID: piActionApprovalActionID(actionID),
    content: formatPiActionPendingNotification({
      actionDetail: piActionNotificationDetail(action?.payload_json),
      actionID,
      actionType: safeText(payload.action_type) || action?.action_type || "",
      issueID: event.issueId
    }),
    conversationID: finalTarget.threadID || finalTarget.chatID,
    idempotencyKey: `pi_action_pending:${actionID}`,
    issueID,
    kind: "pi_action_pending",
    notificationID: actionID,
    notificationType: PI_ACTION_NOTIFY_TYPE,
    payload: {
      action_id: actionID,
      action_type: safeText(payload.action_type),
      issue_id: issueID
    },
    projectID,
    requiresUser: true,
    routes: [feishuRoute(finalTarget)],
    severity: "actionable",
    sourceEventID: actionID,
    sourceEventType: event.type,
    summary: `PI action ${actionID} pending approval`
  })[0];
  return queueResult(result);
}

function piActionNotificationDetail(payloadJSON: string | undefined): string {
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

export function queuePendingPiActionNotifications(
  db: RunnerDatabase,
  config?: FeishuConnectorConfig,
  options: { lookbackMs?: number; maxPerSweep?: number; now?: Date } = {}
): { failed: number; queued: number; scanned: number; skipped: number } {
  const intents = new Map(listPiNotificationIntents(db, { kind: "pi_action_pending" })
    .map((intent) => [intent.source_event_id, intent]));
  const summary = { failed: 0, queued: 0, scanned: 0, skipped: 0 };
  const cutoff = (options.now ?? new Date()).getTime() - (options.lookbackMs ?? 10 * 60_000);
  const maxPerSweep = Math.max(1, Math.min(20, Math.trunc(options.maxPerSweep ?? 5)));
  for (const action of listPiActions(db, { status: "pending" })) {
    summary.scanned += 1;
    if (!MISSED_ACTION_NOTIFICATION_TYPES.has(action.action_type) || !isRecentAction(action.created_at, cutoff)) {
      summary.skipped += 1;
      continue;
    }
    const existing = intents.get(action.id);
    if (existing && existing.state !== "failed") {
      summary.skipped += 1;
      continue;
    }
    if (summary.queued >= maxPerSweep) {
      summary.skipped += 1;
      continue;
    }
    const result = queueFeishuPiActionPendingNotification(db, {
      conversationId: action.conversation_id,
      issueId: action.issue_id || undefined,
      payload: JSON.stringify({ action_id: action.id, action_type: action.action_type, status: action.status }),
      projectId: action.project_id,
      type: "pi.action_pending"
    }, { config });
    if (result.queued) summary.queued += 1;
    else if (result.reason === "missing_feishu_target") summary.failed += 1;
    else summary.skipped += 1;
  }
  return summary;
}

const MISSED_ACTION_NOTIFICATION_TYPES = new Set(["assistant.tool.call", "mcp.tool.call"]);

function isRecentAction(createdAt: string, cutoff: number): boolean {
  const timestamp = Date.parse(createdAt);
  return Number.isFinite(timestamp) && timestamp >= cutoff;
}

function recordUnroutablePiActionNotification(db: RunnerDatabase, input: {
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

export function queueFeishuApprovalNotification(
  db: RunnerDatabase,
  event: AppEvent,
  options: { config?: FeishuConnectorConfig; requireConfigured?: boolean } = {}
): QueueResult {
  if (event.method !== "approval/requested") return { queued: false, reason: "not_approval_request" };
  const parsed = parseCodexApprovalPayload(event);
  const approvalID = parsed.id || safeText(event.threadId) || safeText(event.turnId);
  if (approvalID === "") return { queued: false, reason: "missing_approval_id" };
  const issue = issueForApproval(db, event);
  if (!issue) return { queued: false, reason: "missing_issue" };
  upsertPiApprovalRequest(db, approvalRecordInput(event, issue, parsed, approvalID));
  if (options.requireConfigured && !feishuConfigured(options.config)) {
    return { queued: false, reason: "feishu_not_configured" };
  }
  const target = feishuTargetForIssue(db, issue.id) ?? feishuFallbackTargetForProject(options.config, issue.project_id);
  if (!target) return { queued: false, reason: "missing_feishu_link" };
  const result = routeNotification(db, {
    approvalActionID: approvalID,
    content: formatApprovalNotification(issue, parsed.command, parsed.path),
    conversationID: target.threadID || target.chatID,
    deepLink: `/api/issues/${issue.id}`,
    idempotencyKey: `approval_requested:${approvalID}`,
    issueID: issue.id,
    kind: "approval_requested",
    notificationID: approvalID,
    notificationType: APPROVAL_NOTIFY_TYPE,
    payload: { approval_id: approvalID, issue_id: issue.id, provider: safeText(event.provider) || "codex" },
    projectID: issue.project_id,
    requiresUser: true,
    routes: [{
      channel: "feishu",
      chatID: target.chatID,
      eventID: target.eventID,
      messageID: target.messageID,
      threadID: target.threadID
    }],
    severity: "actionable",
    sourceEventID: approvalID,
    sourceEventType: "approval/requested",
    summary: `issue #${issue.id} approval requested`
  })[0];
  if (!result?.queued) return { queued: false, reason: result?.reason || "duplicate" };
  if (result.reason === "agent_pending") return { queued: true, reason: "queued" };
  markPiApprovalDelivered(db, approvalID, { channel: "feishu" });
  return { queued: true, reason: "queued" };
}

export function queueFeishuHandoffNotification(db: RunnerDatabase, event: AppEvent): QueueResult {
  const payload = parseObject(event.payload);
  const handoffID = safeText(payload.handoff_id);
  const issueID = event.issueId ?? positiveID(payload.issue_id);
  if (handoffID === "" || issueID <= 0) return { queued: false, reason: "missing_handoff_target" };
  const issue = getIssue(db, issueID);
  if (!issue) return { queued: false, reason: "missing_issue" };
  const target = feishuTargetForIssue(db, issueID);
  if (!target) return { queued: false, reason: "missing_feishu_link" };
  const status = safeText(payload.status) || safeText(event.status) || "ready";
  const revision = positiveID(payload.revision);
  const deepLink = safeText(payload.href).startsWith("#/")
    ? safeText(payload.href)
    : `#/work/${encodeURIComponent(`xw:work:issues:${issueID}`)}/delivery/${encodeURIComponent(handoffID)}`;
  const notificationID = `${handoffID}:${revision}:${status}`;
  const result = routeNotification(db, {
    content: `Handoff ${status}：${safeText(payload.summary) || handoffID}`,
    conversationID: target.threadID || target.chatID,
    deepLink,
    idempotencyKey: `handoff:${notificationID}`,
    issueID,
    kind: `handoff_${status}`,
    notificationID,
    notificationType: "feishu_handoff_notification",
    payload,
    projectID: issue.project_id,
    routes: [{
      channel: "feishu",
      chatID: target.chatID,
      eventID: target.eventID,
      messageID: target.messageID,
      threadID: target.threadID
    }],
    severity: "info",
    sourceEventID: handoffID,
    sourceEventType: "handoff.notification",
    summary: safeText(payload.summary) || `Handoff ${status}`
  })[0];
  return result?.queued
    ? { queued: true, reason: "queued" }
    : { queued: false, reason: result?.reason || "duplicate" };
}

function feishuRoute(target: {
  chatID: string;
  eventID: number;
  messageID: string;
  threadID: string;
}) {
  return {
    channel: "feishu",
    chatID: target.chatID,
    eventID: target.eventID,
    messageID: target.messageID,
    threadID: target.threadID
  };
}

function queueResult(result: ReturnType<typeof routeNotification>[number] | undefined): QueueResult {
  return result?.queued
    ? { queued: true, reason: "queued" }
    : { queued: false, reason: result?.reason || "duplicate" };
}

function feishuConfigured(config: FeishuConnectorConfig | undefined): boolean {
  return config !== undefined && feishuConnectorStatus(config).enabled === true;
}

function isPiIssueStartEvent(db: RunnerDatabase, event: AppEvent): boolean {
  if (event.type !== "pi.action_completed" || !event.issueId) return false;
  const payload = parseObject(event.payload);
  if (safeText(payload.action_type) !== "issue.enqueue") return false;
  return !isRunnerChatEnqueueAction(db, payload);
}

function shouldSuppressLifecycleStartNotification(db: RunnerDatabase, issueID: number): boolean {
  const issue = getIssue(db, issueID);
  if (!issue || !["todo", "in_progress"].includes(issue.status)) return false;
  if (hasRunGroupMembership(db, issue.id)) return false;
  const action = latestCompletedEnqueueAction(db, issue.id);
  return action ? isRunnerChatSource(action.source) : false;
}

function hasRunGroupMembership(db: RunnerDatabase, issueID: number): boolean {
  const row = db.sqlite.query<{ count: number }, [number]>(
    "select count(*) as count from pi_run_group_items where issue_id=?"
  ).get(issueID);
  return (row?.count ?? 0) > 0;
}

function latestCompletedEnqueueAction(db: RunnerDatabase, issueID: number) {
  const actions = listPiActions(db, { issueId: issueID })
    .filter((action) => action.action_type === "issue.enqueue" && action.status === "completed");
  return actions.at(-1);
}

function isRunnerChatEnqueueAction(db: RunnerDatabase, payload: Record<string, unknown>): boolean {
  const actionID = safeText(payload.action_id);
  const source = actionID ? getPiAction(db, actionID)?.source : safeText(payload.source);
  return isRunnerChatSource(source);
}

function isRunnerChatSource(value: unknown): boolean {
  const source = safeText(value);
  return source === "feishu_runner_chat" || source === "runner_chat";
}

function positiveID(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  const parsed = Number.parseInt(safeText(value), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function needsUserNotifyID(event: AppEvent, payload: Record<string, unknown>): string {
  return [
    "needs_user",
    safeText(event.projectId) || safeText(payload.project_id),
    String(event.issueId ?? positiveID(payload.issue_id)),
    safeText(payload.reason) || safeText(payload.diagnosis)
  ].join(":");
}

function issueForApproval(db: RunnerDatabase, event: AppEvent): Issue | null {
  if (event.issueId) return getIssue(db, event.issueId);
  const threadID = safeText(event.threadId) || safeText(parseCodexApprovalPayload(event).threadID);
  if (threadID === "") return null;
  const session = listAgentSessions(db, { provider: safeText(event.provider) || "codex" })
    .find((item) => item.provider_session_id === threadID);
  return session?.issue_id ? getIssue(db, session.issue_id) : null;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function safeText(value: unknown): string {
  return typeof value === "string" ? redactSensitiveText(value).trim() : "";
}
