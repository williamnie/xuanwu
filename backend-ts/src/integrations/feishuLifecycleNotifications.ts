import type { RunnerDatabase } from "../db/database.ts";
import { getIssue, type Issue } from "../db/repositories/issues.ts";
import { getPiRunGroup } from "../db/repositories/pi.ts";
import { ingestIssueLifecycleEvent } from "../pi/guardianEventIngest.ts";
import {
  coordinateIssueLifecycleNotification,
  markLifecycleIntentSent,
  suppressLifecycleIntent,
  type LifecycleIntentResult
} from "../pi/notificationCoordinator.ts";
import { formatIssueStatusNotification } from "./feishuNotificationFormatters.ts";
import {
  alreadyQueuedFeishuNotification,
  createFeishuNotificationDraft
} from "./feishuNotificationDrafts.ts";
import {
  feishuTargetForConversation,
  feishuTargetForIssue
} from "./feishuNotificationTargets.ts";

export type QueueResult = { queued: boolean; reason: string };

const ISSUE_STATUS_NOTIFY_TYPE = "feishu_issue_status_notification";
const APPROVAL_NOTIFY_TYPE = "feishu_approval_notification";

export function queueFeishuIssueStatusNotification(
  db: RunnerDatabase,
  issueID: number,
  options: { conversationId?: string; eventType?: string; suppressDirectStart?: boolean } = {}
): QueueResult {
  const issue = getIssue(db, issueID);
  if (!issue) return { queued: false, reason: "issue_not_found" };
  if (!isLifecycleStatus(issue.status)) return { queued: false, reason: "not_notifiable" };
  const event = ingestIssueLifecycleEvent(db, {
    conversationID: options.conversationId,
    eventType: options.eventType || "issue.status_changed",
    issue
  });
  const target = lifecycleTarget(db, issue.id, options.conversationId, event.run_group_id);
  const intentResult = createLifecycleIntent(db, issue, event, target);
  if (intentResult.decision === "suppress") {
    return { queued: false, reason: "run_group_lifecycle_suppressed" };
  }
  if (intentResult.decision === "aggregate") {
    return { queued: false, reason: "run_group_lifecycle_aggregated" };
  }
  if (options.suppressDirectStart && isStartStatus(issue.status)) {
    suppressLifecycleIntent(db, intentResult.intent, "runner_chat_start_summarized_by_pi");
    return { queued: false, reason: "runner_chat_start_summarized_by_pi" };
  }
  if (!target) return { queued: false, reason: "missing_feishu_link" };
  return queueLegacyFeishuDraft(db, issue, target, intentResult);
}

function isLifecycleStatus(status: string): boolean {
  return ["todo", "in_progress", "done", "failed", "pending_verification"].includes(status);
}

function isStartStatus(status: string): boolean {
  return status === "todo" || status === "in_progress";
}

function createLifecycleIntent(
  db: RunnerDatabase,
  issue: Issue,
  event: ReturnType<typeof ingestIssueLifecycleEvent>,
  target: ReturnType<typeof feishuTargetForIssue>
): LifecycleIntentResult {
  return coordinateIssueLifecycleNotification(db, {
    event,
    issue,
    target: target ? {
      chatID: target.chatID,
      messageID: target.messageID,
      threadID: target.threadID
    } : undefined
  });
}

function lifecycleTarget(
  db: RunnerDatabase,
  issueID: number,
  conversationID: string | undefined,
  runGroupID: string
) {
  return feishuTargetForIssue(db, issueID) ??
    feishuTargetForConversation(db, conversationID ?? "") ??
    feishuTargetForConversation(db, getPiRunGroup(db, runGroupID)?.origin_conversation_id ?? "");
}

function queueLegacyFeishuDraft(
  db: RunnerDatabase,
  issue: Issue,
  target: NonNullable<ReturnType<typeof feishuTargetForIssue>>,
  intentResult: LifecycleIntentResult
): QueueResult {
  const notifyID = issueNotificationID(issue);
  if (alreadyQueuedFeishuNotification(db, APPROVAL_NOTIFY_TYPE, notifyID) ||
    alreadyQueuedFeishuNotification(db, ISSUE_STATUS_NOTIFY_TYPE, notifyID)) {
    if (intentResult.intent.state !== "sent") {
      suppressLifecycleIntent(db, intentResult.intent, "duplicate_legacy_feishu_notification");
    }
    return { queued: false, reason: "duplicate" };
  }
  const draft = createFeishuNotificationDraft(db, issue, target, {
    content: formatIssueStatusNotification(issue),
    notifyID,
    type: ISSUE_STATUS_NOTIFY_TYPE
  });
  markLifecycleIntentSent(db, intentResult.intent, draft.outboxID);
  return { queued: true, reason: "queued" };
}

function issueNotificationID(issue: Issue): string {
  return ["todo", "in_progress"].includes(issue.status) ? `${issue.id}:start` : `${issue.id}:${issue.status}`;
}
