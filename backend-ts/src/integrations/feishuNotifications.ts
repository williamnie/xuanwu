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
import { redactSensitiveText } from "../util/redact.ts";
import {
  formatApprovalNotification,
  formatMemoryCandidateNotification,
  formatPiActionPendingNotification
} from "./feishuNotificationFormatters.ts";
import {
  alreadyQueuedFeishuNotification,
  createFeishuNotificationDraft
} from "./feishuNotificationDrafts.ts";
import {
  feishuTargetForConversation,
  feishuTargetForIssue
} from "./feishuNotificationTargets.ts";
import {
  queueFeishuIssueStatusNotification,
  type QueueResult
} from "./feishuLifecycleNotifications.ts";

const APPROVAL_NOTIFY_TYPE = "feishu_approval_notification";
const MEMORY_NOTIFY_TYPE = "feishu_memory_candidate_notification";
const PI_ACTION_NOTIFY_TYPE = "feishu_pi_action_pending_notification";

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
          eventType: event.type,
          suppressDirectStart: shouldSuppressLifecycleStartNotification(input.database, event.issueId)
        });
        dispatchIfQueued(input, result);
      }
      if (isPiIssueStartEvent(input.database, event)) {
        const result = queueFeishuIssueStatusNotification(input.database, event.issueId ?? 0, {
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
  createFeishuNotificationDraft(db, issue, target, {
    approvalActionID: approvalID,
    content: formatApprovalNotification(issue, parsed.command, parsed.path),
    notifyID: approvalID,
    type: APPROVAL_NOTIFY_TYPE
  });
  markPiApprovalDelivered(db, approvalID, { channel: "feishu" });
  return { queued: true, reason: "queued" };
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
