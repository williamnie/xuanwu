import type { RunnerDatabase } from "../../db/database.ts";
import { getIssue, type Issue } from "../../db/repositories/issues.ts";
import { readIssueDecisionProjection } from "../../domain/review/humanReview.ts";
import { readHumanFeedback } from "../../domain/review/humanFeedback.ts";
import { humanFeedbackNotificationText } from "../../notifications/humanFeedbackPresentation.ts";
import { listAgentSessions } from "../../db/repositories/agentSessions.ts";
import { getPiAction } from "../../db/repositories/pi.ts";
import type { AppEvent } from "../../events/bus.ts";
import type { FeishuConnectorConfig } from "./feishu.ts";
import { feishuConnectorStatus } from "./feishu.ts";
import { parseCodexApprovalPayload } from "./feishuApprovalRequests.ts";
import { routeNotification } from "../../notifications/unifiedNotificationPipeline.ts";
import { formatPiActionPendingNotification, formatPiNeedsUserNotification } from "./feishuNotificationFormatters.ts";
import { piActionApprovalActionID } from "./feishuPiActionCards.ts";
import { feishuFallbackTargetForProject, feishuTargetForConversation, feishuTargetForIssue } from "./feishuNotificationTargets.ts";
import { type QueueResult } from "./feishuLifecycleNotifications.ts";
import { parseObject, safeText, providerTarget, resolveGenericTarget, PI_NEEDS_USER_NOTIFY_TYPE, notificationRoute, queueResult, recordUnroutablePiActionNotification, piActionNotificationDetail, PI_ACTION_NOTIFY_TYPE } from "./feishuNotifications.dispatchIfQueued.ts";

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
  const decision = issue ? readIssueDecisionProjection(db, issueID) : null;
  const reviewID = safeText(payload.review_request_id);
  if (reviewID && (decision?.request?.id !== reviewID || decision.request.revision !== payload.review_revision
    || decision.owner !== "human" || decision.request.status !== "open")) return { queued: false, reason: "stale_review_request" };
  const feedbackText = issue ? humanFeedbackNotificationText(readHumanFeedback(db, issueID, decision!)) : "";
  const target = issue ? feishuTargetForIssue(db, issue.id) : null;
  const fallback = feishuTargetForConversation(db, safeText(event.conversationId));
  const projectID = issue?.project_id ?? safeText(event.projectId);
  const explicitProjectTarget = options.config?.projectMappings.some(mapping => mapping.projectId === projectID && (mapping.chatId || mapping.userId));
  // GitHub 已有版本绑定的求助回写，不再落到无关的默认飞书会话；显式飞书绑定仍然有效。
  if (issue && !target && !fallback && !explicitProjectTarget && db.sqlite.query(
    "select 1 from github_issue_cases where issue_id=? and stage in ('investigate','repair') and external_state='open'"
  ).get(issue.id)) return { queued: false, reason: "github_review_owns_target" };
  const projectFallback = feishuFallbackTargetForProject(options.config, projectID);
  const finalTarget = providerTarget("feishu", target ?? fallback ?? projectFallback) ?? resolveGenericTarget(db, {
    conversationID: safeText(event.conversationId),
    issueID,
    projectID
  });
  if (!finalTarget) return { queued: false, reason: "missing_feishu_target" };
  const result = routeNotification(db, {
    content: [formatPiNeedsUserNotification({
      diagnosis: safeText(payload.diagnosis) || safeText(payload.reason),
      issueID: issueID || undefined,
      message: safeText(payload.message) || safeText(event.text),
      nextStep: safeText(payload.next_step) || safeText(payload.nextStep),
      provider: safeText(payload.provider),
      userFacingMessage: safeText(payload.user_facing_message)
    }), reviewID ? `请求 ${reviewID} · 版本 ${decision!.request!.revision}；可在当前 IM 对话回答。` : "", feedbackText].filter(Boolean).join("\n"),
    deepLink: issue ? `#/work/${encodeURIComponent(`xw:work:issues:${issueID}`)}` : undefined,
    conversationID: finalTarget.threadID || finalTarget.chatID,
    idempotencyKey: `pi_needs_user:${notifyID}`,
    issueID,
    kind: "pi_needs_user",
    notificationID: notifyID,
    notificationType: PI_NEEDS_USER_NOTIFY_TYPE,
    payload: {
      action_id: notifyID,
      issue_id: issueID,
      provider: safeText(payload.provider),
      ...(reviewID ? { review_request_id: reviewID, review_revision: decision!.request!.revision } : {})
    },
    projectID,
    requiresUser: true,
    routes: [notificationRoute(finalTarget)],
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
  const finalTarget = providerTarget("feishu", target ?? fallback ?? projectFallback) ?? resolveGenericTarget(db, {
    conversationID: safeText(event.conversationId),
    issueID,
    projectID
  });
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
    routes: [notificationRoute(finalTarget)],
    severity: "actionable",
    sourceEventID: actionID,
    sourceEventType: event.type,
    summary: `PI action ${actionID} pending approval`
  })[0];
  return queueResult(result);
}

export function queueFeishuHandoffNotification(db: RunnerDatabase, event: AppEvent): QueueResult {
  const payload = parseObject(event.payload);
  const handoffID = safeText(payload.handoff_id);
  const issueID = event.issueId ?? positiveID(payload.issue_id);
  if (handoffID === "" || issueID <= 0) return { queued: false, reason: "missing_handoff_target" };
  const issue = getIssue(db, issueID);
  if (!issue) return { queued: false, reason: "missing_issue" };
  const target = providerTarget("feishu", feishuTargetForIssue(db, issueID)) ?? resolveGenericTarget(db, {
    conversationID: safeText(event.conversationId),
    issueID,
    projectID: issue.project_id
  });
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
    routes: [notificationRoute(target)],
    severity: "info",
    sourceEventID: handoffID,
    sourceEventType: "handoff.notification",
    summary: safeText(payload.summary) || `Handoff ${status}`
  })[0];
  return result?.queued
    ? { queued: true, reason: "queued" }
    : { queued: false, reason: result?.reason || "duplicate" };
}

export function feishuConfigured(config: FeishuConnectorConfig | undefined): boolean {
  return config !== undefined && feishuConnectorStatus(config).enabled === true;
}

export function positiveID(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  const parsed = Number.parseInt(safeText(value), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function needsUserNotifyID(event: AppEvent, payload: Record<string, unknown>): string {
  return [
    "needs_user",
    safeText(event.projectId) || safeText(payload.project_id),
    String(event.issueId ?? positiveID(payload.issue_id)),
    safeText(payload.reason) || safeText(payload.diagnosis)
  ].join(":");
}

export function issueForApproval(db: RunnerDatabase, event: AppEvent): Issue | null {
  if (event.issueId) return getIssue(db, event.issueId);
  const threadID = safeText(event.threadId) || safeText(parseCodexApprovalPayload(event).threadID);
  if (threadID === "") return null;
  const session = listAgentSessions(db, { provider: safeText(event.provider) || "codex" })
    .find((item) => item.provider_session_id === threadID);
  return session?.issue_id ? getIssue(db, session.issue_id) : null;
}
