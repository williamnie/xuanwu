import type { RunnerDatabase } from "../db/database.ts";
import { getIssue, type Issue } from "../db/repositories/issues.ts";
import { readHumanFeedback } from "../domain/review/humanFeedback.ts";
import { humanFeedbackNotificationText } from "../notifications/humanFeedbackPresentation.ts";
import { listExternalLinksByIssue } from "../db/repositories/externalLinks.ts";
import {
  getPiRunGroup,
  listPiActions,
  listPiNotificationIntents,
  type PiNotificationIntent
} from "../db/repositories/pi.ts";
import { issueCompletionAutomationOwnsTargetForIssue } from "../pi/issueCompletionAutomation.ts";
import type { FeishuConnectorConfig } from "./feishu.ts";
import { queueReadyDigestNotifications, type DigestNotificationQueueOptions } from "../pi/digestNotifications.ts";
import { ingestIssueLifecycleEvent } from "../pi/guardianEventIngest.ts";
import {
  coordinateIssueLifecycleNotification,
  suppressLifecycleIntent,
  type LifecycleIntentResult
} from "../pi/notificationCoordinator.ts";
import { queueExistingNotificationIntent } from "../notifications/unifiedNotificationPipeline.ts";
import { formatIssueStatusNotification } from "./feishuNotificationFormatters.ts";
import {
  feishuFallbackTargetForProject,
  feishuTargetForConversation,
  feishuTargetForIssue,
  feishuTargetForProject
} from "./feishuNotificationTargets.ts";
import {
  resolveImNotificationConnectorID,
  resolveImNotificationTarget
} from "./imNotificationTargets.ts";

export type QueueResult = { queued: boolean; reason: string };
export type DigestQueueResult = { failed: number; queued: number; scanned: number; skipped: number };

const ISSUE_STATUS_NOTIFY_TYPE = "feishu_issue_status_notification";
const DIGEST_NOTIFY_TYPE = "feishu_run_group_digest_notification";

type LifecycleTarget = {
  connectorID: string;
  chatID: string;
  eventID: number;
  messageID: string;
  threadID: string;
};

export function queueFeishuIssueStatusNotification(
  db: RunnerDatabase,
  issueID: number,
  options: {
    config?: FeishuConnectorConfig;
    conversationId?: string;
    eventType?: string;
    now?: Date;
    suppressDirectStart?: boolean;
  } = {}
): QueueResult {
  const issue = getIssue(db, issueID);
  if (!issue) return { queued: false, reason: "issue_not_found" };
  if (issue.status === "needs_user") {
    return { queued: false, reason: "needs_user_notification_uses_pi_channel" };
  }
  if (!isLifecycleStatus(issue.status)) return { queued: false, reason: "not_notifiable" };
  const runGroupID = latestRunGroupIDForIssue(db, issue.id);
  const conversationID = lifecycleConversationID(db, issue, options.conversationId, runGroupID);
  const event = ingestIssueLifecycleEvent(db, {
    conversationID,
    eventType: options.eventType || "issue.status_changed",
    issue,
    runGroupID
  });
  const linkedTarget = linkedLifecycleTarget(db, issue.id, conversationID, event.run_group_id) ??
    genericLifecycleTarget(db, issue.id, issue.project_id, conversationID) ??
    latestLifecycleIntentTarget(db, issue.id) ??
    providerTarget("feishu", feishuTargetForProject(db, issue.project_id));
  if (!linkedTarget && issueCompletionAutomationOwnsTargetForIssue(db, issue.id)) {
    return { queued: false, reason: "issue_completion_watch_owns_target" };
  }
  const target = linkedTarget ?? providerTarget("feishu", fallbackLifecycleTarget(issue, options.config));
  const feedback = readHumanFeedback(db, issue.id);
  const intentResult = createLifecycleIntent(db, issue, event, target, options.now, feedback?.source_event_id);
  if (intentResult.decision === "suppress") {
    return { queued: false, reason: "run_group_lifecycle_suppressed" };
  }
  if (intentResult.decision === "aggregate") {
    return { queued: false, reason: "run_group_lifecycle_aggregated" };
  }
  if (options.suppressDirectStart && isStartStatus(issue.status) && !feedback) {
    suppressLifecycleIntent(db, intentResult.intent, "runner_chat_start_summarized_by_pi");
    return { queued: false, reason: "runner_chat_start_summarized_by_pi" };
  }
  if (!target) {
    suppressLifecycleIntent(db, intentResult.intent, "missing_feishu_link");
    return { queued: false, reason: "missing_feishu_link" };
  }
  return queueLifecycleIntent(db, issue, target, intentResult);
}

export function queueReadyFeishuDigestNotifications(
  db: RunnerDatabase,
  options: DigestNotificationQueueOptions = {}
): DigestQueueResult {
  return queueReadyDigestNotifications(db, {
    channel: "feishu",
    missingRouteReason: () => "missing_feishu_target",
    notificationType: DIGEST_NOTIFY_TYPE,
    resolveRoute: (database, intent) => {
      const target = digestTarget(database, intent);
      return target ? { channel: "feishu", ...target } : null;
    }
  }, options);
}

function isLifecycleStatus(status: string): boolean {
  return ["todo", "in_progress", "needs_user", "done", "failed"].includes(status);
}

function isStartStatus(status: string): boolean {
  return status === "todo" || status === "in_progress";
}

function createLifecycleIntent(
  db: RunnerDatabase,
  issue: Issue,
  event: ReturnType<typeof ingestIssueLifecycleEvent>,
  target: LifecycleTarget | null,
  now?: Date,
  feedbackEventID?: number
): LifecycleIntentResult {
  return coordinateIssueLifecycleNotification(db, {
    event,
    feedbackEventID,
    issue,
    now,
    target: target ? {
      connectorID: target.connectorID,
      chatID: target.chatID,
      messageID: target.messageID,
      threadID: target.threadID
    } : undefined
  });
}

function linkedLifecycleTarget(
  db: RunnerDatabase,
  issueID: number,
  conversationID: string | undefined,
  runGroupID: string
): LifecycleTarget | null {
  const target = feishuTargetForIssue(db, issueID) ??
    feishuTargetForConversation(db, conversationID ?? "") ??
    feishuTargetForConversation(db, getPiRunGroup(db, runGroupID)?.origin_conversation_id ?? "") ??
    feishuTargetForConversation(db, legacyEnqueueConversationID(db, issueID));
  return providerTarget("feishu", target);
}

function fallbackLifecycleTarget(issue: Issue, config: FeishuConnectorConfig | undefined) {
  if (issue.status !== "failed") return null;
  return feishuFallbackTargetForProject(config, issue.project_id);
}

function legacyEnqueueConversationID(db: RunnerDatabase, issueID: number): string {
  return listPiActions(db, { issueId: issueID })
    .filter((action) => action.action_type === "issue.enqueue" && action.status === "completed")
    .map((action) => action.conversation_id)
    .filter((conversationID) => conversationID !== "")
    .at(-1) ?? "";
}

function lifecycleConversationID(
  db: RunnerDatabase,
  issue: Issue,
  explicitConversationID: string | undefined,
  runGroupID: string
): string {
  const explicit = cleanString(explicitConversationID);
  if (explicit !== "" || runGroupID !== "") return explicit;
  return issueLinkConversationID(db, issue.id) ||
    legacyEnqueueConversationID(db, issue.id) ||
    latestLifecycleIntentConversationID(db, issue.id) ||
    sourceSessionConversationID(issue.source_session_id);
}

function latestLifecycleIntentTarget(db: RunnerDatabase, issueID: number) {
  const intent = listPiNotificationIntents(db, { issueId: issueID })
    .filter((candidate) => candidate.target_chat_id !== "" || candidate.target_message_id !== "")
    .at(-1);
  if (!intent) return null;
  return {
    connectorID: intent.target_channel || "feishu",
    chatID: intent.target_chat_id,
    eventID: 0,
    messageID: intent.target_message_id,
    threadID: intent.target_thread_id
  };
}

function latestLifecycleIntentConversationID(db: RunnerDatabase, issueID: number): string {
  return listPiNotificationIntents(db, { issueId: issueID })
    .map((intent) => cleanString(intent.conversation_id))
    .filter(Boolean)
    .at(-1) ?? "";
}

function latestRunGroupIDForIssue(db: RunnerDatabase, issueID: number): string {
  const row = db.sqlite.query<{ run_group_id: string }, [number]>(
    `select run_group_id from pi_run_group_items
     where issue_id=? order by joined_at desc, run_group_id desc limit 1`
  ).get(issueID);
  return cleanString(row?.run_group_id);
}

function issueLinkConversationID(db: RunnerDatabase, issueID: number): string {
  return listExternalLinksByIssue(db, issueID)
    .map((link) => cleanString(link.conversation_id))
    .find(Boolean) ?? "";
}

function sourceSessionConversationID(value: string): string {
  const text = cleanString(value);
  const separator = text.indexOf(":");
  return separator > 0 && ["feishu", "telegram"].includes(text.slice(0, separator))
    ? cleanString(text.slice(separator + 1))
    : "";
}

function queueLifecycleIntent(
  db: RunnerDatabase,
  issue: Issue,
  target: LifecycleTarget,
  intentResult: LifecycleIntentResult
): QueueResult {
  const feedback = readHumanFeedback(db, issue.id);
  const notifyID = feedback ? `${issueNotificationID(issue)}:feedback:${feedback.source_event_id}` : issueNotificationID(issue);
  const queued = queueExistingNotificationIntent(db, {
    content: feedback
      ? `#${issue.id} · ${humanFeedbackNotificationText(feedback)}`
      : formatIssueStatusNotification(issue),
    deepLink: `#/work/${encodeURIComponent(`xw:work:issues:${issue.id}`)}`,
    intent: intentResult.intent,
    notificationID: notifyID,
    notificationType: ISSUE_STATUS_NOTIFY_TYPE,
    route: {
      channel: target.connectorID,
      chatID: target.chatID,
      eventID: target.eventID,
      messageID: target.messageID,
      threadID: target.threadID
    }
  });
  return { queued: queued.queued, reason: queued.queued ? "queued" : queued.reason };
}

function providerTarget(
  connectorID: string,
  target: { chatID: string; eventID: number; messageID: string; threadID: string } | null | undefined
): LifecycleTarget | null {
  return target ? { connectorID, ...target } : null;
}

function genericLifecycleTarget(
  db: RunnerDatabase,
  issueID: number,
  projectID: string,
  conversationID: string
): LifecycleTarget | null {
  const connectorID = resolveImNotificationConnectorID(db, { conversationID, issueID, projectID });
  if (connectorID === "") return null;
  const target = resolveImNotificationTarget(db, { connectorID, conversationID, issueID, projectID });
  return target ? {
    connectorID: target.connector_id,
    chatID: target.conversation_id,
    eventID: target.external_event_id,
    messageID: target.reply_to_message_id ?? "",
    threadID: target.thread_id ?? ""
  } : null;
}

function digestTarget(db: RunnerDatabase, intent: PiNotificationIntent) {
  if (intent.target_chat_id !== "" || intent.target_message_id !== "") {
    return {
      chatID: intent.target_chat_id,
      eventID: 0,
      messageID: intent.target_message_id,
      threadID: intent.target_thread_id
    };
  }
  return feishuTargetForConversation(db, intent.conversation_id) ??
    feishuTargetForConversation(db, getPiRunGroup(db, intent.run_group_id)?.origin_conversation_id ?? "");
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function issueNotificationID(issue: Issue): string {
  return ["todo", "in_progress"].includes(issue.status) ? `${issue.id}:start` : `${issue.id}:${issue.status}`;
}
