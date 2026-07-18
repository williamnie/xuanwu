import type { RunnerDatabase } from "../db/database.ts";
import { getIssue, type Issue } from "../db/repositories/issues.ts";
import { listAgentSessions } from "../db/repositories/agentSessions.ts";
import {
  getPiAction,
  getPiMemoryItem,
  getPiApprovalRequest,
  listPiActions,
  listPiApprovalRequests,
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
import { dispatchFeishuOutbox, type FeishuMessageSender } from "../pi/imReplyOutboxDispatcher.ts";
import { routeNotification } from "../notifications/unifiedNotificationPipeline.ts";
import { redactSensitiveText } from "../util/redact.ts";
import {
  formatApprovalNotification,
  formatMemoryCandidateNotification,
  formatPiActionPendingNotification,
  formatPiNeedsUserNotification
} from "./feishuNotificationFormatters.ts";
import { piActionApprovalActionID } from "./feishuPiActionCards.ts";
import {
  alreadyQueuedFeishuNotification,
  createFeishuNotificationDraft
} from "./feishuNotificationDrafts.ts";
import {
  feishuFallbackTargetForProject,
  feishuTargetForConversation,
  feishuTargetForIssue
} from "./feishuNotificationTargets.ts";
import {
  queueFeishuIssueStatusNotification,
  type QueueResult
} from "./feishuLifecycleNotifications.ts";
import { queueReadyFeishuCompletionWatchNotifications } from "./feishuCompletionWatchNotifications.ts";

const APPROVAL_NOTIFY_TYPE = "feishu_approval_notification";
const MEMORY_NOTIFY_TYPE = "feishu_memory_candidate_notification";
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
        const watches = queueReadyFeishuCompletionWatchNotifications(input.database);
        dispatchIfNotificationsQueued(input, watches);
      }
      if (isPiIssueStartEvent(input.database, event)) {
        const result = queueFeishuIssueStatusNotification(input.database, event.issueId ?? 0, {
          config: input.config,
          conversationId: event.conversationId
        });
        dispatchIfQueued(input, result);
      }
      if (event.type === "pi.memory_candidate") {
        const result = queueFeishuMemoryCandidateNotification(input.database, event);
        dispatchIfQueued(input, result);
      }
      if (event.type === "pi.action_pending") {
        const result = queueFeishuPiActionPendingNotification(input.database, event);
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
  sender?: FeishuMessageSender;
}, result: QueueResult): void {
  if (!result.queued || !input.config) return;
  const sender = input.sender ?? createFeishuMessageClient({ config: input.config });
  void dispatchFeishuOutbox({ config: input.config, database: input.database, sender }).catch(() => {});
}

function dispatchIfNotificationsQueued(input: {
  config?: FeishuConnectorConfig;
  database: RunnerDatabase;
  sender?: FeishuMessageSender;
}, result: { queued: number }): void {
  if (result.queued <= 0 || !input.config) return;
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
  if (alreadyQueuedFeishuNotification(db, PI_NEEDS_USER_NOTIFY_TYPE, notifyID)) return { queued: false, reason: "duplicate" };
  const issue = issueID > 0 ? getIssue(db, issueID) : null;
  const target = issue ? feishuTargetForIssue(db, issue.id) : null;
  const fallback = feishuTargetForConversation(db, safeText(event.conversationId));
  const projectID = issue?.project_id ?? safeText(event.projectId);
  const projectFallback = feishuFallbackTargetForProject(options.config, projectID);
  const finalTarget = target ?? fallback ?? projectFallback;
  if (!finalTarget) return { queued: false, reason: "missing_feishu_target" };
  createFeishuNotificationDraft(db, issue ?? { id: issueID, project_id: projectID }, finalTarget, {
    content: formatPiNeedsUserNotification({
      diagnosis: safeText(payload.diagnosis) || safeText(payload.reason),
      issueID: issueID || undefined,
      message: safeText(payload.message) || safeText(event.text),
      nextStep: safeText(payload.next_step) || safeText(payload.nextStep),
      provider: safeText(payload.provider),
      userFacingMessage: safeText(payload.user_facing_message)
    }),
    notifyID,
    type: PI_NEEDS_USER_NOTIFY_TYPE
  });
  return { queued: true, reason: "queued" };
}

export function queueFeishuMemoryCandidateNotification(db: RunnerDatabase, event: AppEvent): QueueResult {
  const payload = parseObject(event.payload);
  const itemID = safeText(payload.id);
  if (itemID === "") return { queued: false, reason: "missing_memory_id" };
  const item = getPiMemoryItem(db, itemID);
  if (!item || item.disabled !== 1) return { queued: false, reason: "memory_candidate_not_pending" };
  if (alreadyQueuedFeishuNotification(db, MEMORY_NOTIFY_TYPE, item.id)) return { queued: false, reason: "duplicate" };
  const target = feishuTargetForConversation(db, safeText(event.conversationId) || safeText(item.source_id));
  if (!target) return { queued: false, reason: "missing_feishu_target" };
  createFeishuNotificationDraft(db, { id: 0, project_id: safeText(event.projectId) || itemProjectID(item) }, target, {
    content: formatMemoryCandidateNotification(item),
    notifyID: item.id,
    type: MEMORY_NOTIFY_TYPE
  });
  return { queued: true, reason: "queued" };
}

export function queueFeishuPiActionPendingNotification(db: RunnerDatabase, event: AppEvent): QueueResult {
  const payload = parseObject(event.payload);
  const actionID = safeText(payload.action_id);
  if (actionID === "") return { queued: false, reason: "missing_action_id" };
  if (alreadyQueuedFeishuNotification(db, PI_ACTION_NOTIFY_TYPE, actionID)) return { queued: false, reason: "duplicate" };
  const issue = event.issueId ? getIssue(db, event.issueId) : null;
  const target = issue ? feishuTargetForIssue(db, issue.id) : null;
  const fallback = feishuTargetForConversation(db, safeText(event.conversationId));
  const finalTarget = target ?? fallback;
  if (!finalTarget) return { queued: false, reason: "missing_feishu_target" };
  createFeishuNotificationDraft(db, issue ?? { id: event.issueId ?? 0, project_id: safeText(event.projectId) }, finalTarget, {
    approvalActionID: piActionApprovalActionID(actionID),
    content: formatPiActionPendingNotification({
      actionID,
      actionType: safeText(payload.action_type),
      issueID: event.issueId
    }),
    notifyID: actionID,
    type: PI_ACTION_NOTIFY_TYPE
  });
  return { queued: true, reason: "queued" };
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
  const target = feishuTargetForIssue(db, issue.id);
  if (!target) return { queued: false, reason: "missing_feishu_link" };
  if (alreadyQueuedFeishuNotification(db, APPROVAL_NOTIFY_TYPE, approvalID)) return { queued: false, reason: "duplicate" };
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
    : `#/handoffs/${encodeURIComponent(handoffID)}`;
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

function itemProjectID(item: { scope: string; scope_id: string }): string {
  return item.scope === "project" ? safeText(item.scope_id) : "";
}
