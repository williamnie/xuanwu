import type { RunnerDatabase } from "../../db/database.ts";
import { listPiActions, listPiNotificationIntents, markPiApprovalDelivered, upsertPiApprovalRequest } from "../../db/repositories/pi.ts";
import type { AppEvent, EventBus } from "../../events/bus.ts";
import type { FeishuConnectorConfig } from "./feishu.ts";
import { approvalRecordInput, parseCodexApprovalPayload, recordCodexApprovalResolved } from "./feishuApprovalRequests.ts";
import { type FeishuMessageSender } from "./feishuOutboxDispatcherCompat.ts";
import type { ImChannelRegistry } from "../im/imChannelContracts.ts";
import type { ChannelConnector } from "../channelConnectorContracts.ts";
import { routeNotification } from "../../notifications/unifiedNotificationPipeline.ts";
import { formatApprovalNotification } from "./feishuNotificationFormatters.ts";
import { feishuFallbackTargetForProject, feishuTargetForIssue } from "./feishuNotificationTargets.ts";
import { queueFeishuIssueStatusNotification, type QueueResult } from "./feishuLifecycleNotifications.ts";
import { shouldSuppressLifecycleStartNotification, dispatchIfQueued, isPiIssueStartEvent, safeText, providerTarget, resolveGenericTarget, APPROVAL_NOTIFY_TYPE, notificationRoute } from "./feishuNotifications.dispatchIfQueued.ts";
import { queueFeishuPiActionPendingNotification, queueFeishuPiNeedsUserNotification, queueFeishuHandoffNotification, issueForApproval, feishuConfigured } from "./feishuNotifications.queueFeishuPiNeedsUserNotification.ts";

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

export const MISSED_ACTION_NOTIFICATION_TYPES = new Set(["assistant.tool.call", "mcp.tool.call"]);

export function isRecentAction(createdAt: string, cutoff: number): boolean {
  const timestamp = Date.parse(createdAt);
  return Number.isFinite(timestamp) && timestamp >= cutoff;
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
  const target = providerTarget("feishu", feishuTargetForIssue(db, issue.id) ?? feishuFallbackTargetForProject(options.config, issue.project_id)) ??
    resolveGenericTarget(db, {
      conversationID: safeText(event.conversationId),
      issueID: issue.id,
      projectID: issue.project_id
    });
  if (options.requireConfigured && !target && !feishuConfigured(options.config)) {
    return { queued: false, reason: "feishu_not_configured" };
  }
  if (options.requireConfigured && target?.connectorID === "feishu" && !feishuConfigured(options.config)) {
    return { queued: false, reason: "feishu_not_configured" };
  }
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
    routes: [notificationRoute(target)],
    severity: "actionable",
    sourceEventID: approvalID,
    sourceEventType: "approval/requested",
    summary: `issue #${issue.id} approval requested`
  })[0];
  if (!result?.queued) return { queued: false, reason: result?.reason || "duplicate" };
  if (result.reason === "agent_pending") return { queued: true, reason: "queued" };
  markPiApprovalDelivered(db, approvalID, { channel: target.connectorID });
  return { queued: true, reason: "queued" };
}
