import type { RunnerDatabase } from "../db/database.ts";
import { getIssue, type Issue } from "../db/repositories/issues.ts";
import { listExternalLinksByIssue } from "../db/repositories/externalLinks.ts";
import {
  getPiRunGroup,
  listPiActions,
  listPiNotificationIntents,
  type PiNotificationIntent
} from "../db/repositories/pi.ts";
import { issueCompletionAutomationOwnsTargetForIssue } from "../pi/issueCompletionAutomation.ts";
import type { FeishuConnectorConfig } from "./feishu.ts";
import { formatRunGroupDigest } from "../pi/digestFormatter.ts";
import { ingestIssueLifecycleEvent } from "../pi/guardianEventIngest.ts";
import {
  coordinateIssueLifecycleNotification,
  markNotificationIntentRetry,
  suppressLifecycleIntent,
  type LifecycleIntentResult
} from "../pi/notificationCoordinator.ts";
import { queueExistingNotificationIntent } from "../notifications/unifiedNotificationPipeline.ts";
import { formatIssueStatusNotification } from "./feishuNotificationFormatters.ts";
import {
  feishuFallbackTargetForProject,
  feishuTargetForConversation,
  feishuTargetForIssue
} from "./feishuNotificationTargets.ts";

export type QueueResult = { queued: boolean; reason: string };
export type DigestQueueResult = { failed: number; queued: number; scanned: number; skipped: number };

const ISSUE_STATUS_NOTIFY_TYPE = "feishu_issue_status_notification";
const DIGEST_NOTIFY_TYPE = "feishu_run_group_digest_notification";
const DEFAULT_DIGEST_LIMIT = 20;

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
  if (!isLifecycleStatus(issue.status)) return { queued: false, reason: "not_notifiable" };
  const runGroupID = latestRunGroupIDForIssue(db, issue.id);
  const conversationID = lifecycleConversationID(db, issue, options.conversationId, runGroupID);
  const event = ingestIssueLifecycleEvent(db, {
    conversationID,
    eventType: options.eventType || "issue.status_changed",
    issue,
    runGroupID
  });
  const linkedTarget = linkedLifecycleTarget(db, issue.id, conversationID, event.run_group_id);
  if (!linkedTarget && issueCompletionAutomationOwnsTargetForIssue(db, issue.id)) {
    return { queued: false, reason: "issue_completion_watch_owns_target" };
  }
  const target = linkedTarget ?? fallbackLifecycleTarget(issue, options.config);
  const intentResult = createLifecycleIntent(db, issue, event, target, options.now);
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
  if (!target) {
    suppressLifecycleIntent(db, intentResult.intent, "missing_feishu_link");
    return { queued: false, reason: "missing_feishu_link" };
  }
  return queueLifecycleIntent(db, issue, target, intentResult);
}

export function queueReadyFeishuDigestNotifications(
  db: RunnerDatabase,
  options: { limit?: number } = {}
): DigestQueueResult {
  const intents = readyDigestIntents(db, options.limit ?? DEFAULT_DIGEST_LIMIT);
  const result: DigestQueueResult = { failed: 0, queued: 0, scanned: intents.length, skipped: 0 };
  for (const intent of intents) safelyQueueDigestIntent(db, intent, result);
  return result;
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
  target: ReturnType<typeof feishuTargetForIssue>,
  now?: Date
): LifecycleIntentResult {
  return coordinateIssueLifecycleNotification(db, {
    event,
    issue,
    now,
    target: target ? {
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
) {
  return feishuTargetForIssue(db, issueID) ??
    feishuTargetForConversation(db, conversationID ?? "") ??
    feishuTargetForConversation(db, getPiRunGroup(db, runGroupID)?.origin_conversation_id ?? "") ??
    feishuTargetForConversation(db, legacyEnqueueConversationID(db, issueID));
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
    legacyEnqueueConversationID(db, issue.id) || sourceSessionConversationID(issue.source_session_id);
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
    .filter((link) => link.source === "feishu")
    .map((link) => cleanString(link.conversation_id))
    .find(Boolean) ?? "";
}

function sourceSessionConversationID(value: string): string {
  const text = cleanString(value);
  return text.startsWith("feishu:") ? cleanString(text.slice("feishu:".length)) : "";
}

function queueLifecycleIntent(
  db: RunnerDatabase,
  issue: Issue,
  target: NonNullable<ReturnType<typeof feishuTargetForIssue>>,
  intentResult: LifecycleIntentResult
): QueueResult {
  const notifyID = issueNotificationID(issue);
  const queued = queueExistingNotificationIntent(db, {
    content: formatIssueStatusNotification(issue),
    deepLink: `/api/issues/${issue.id}`,
    intent: intentResult.intent,
    notificationID: notifyID,
    notificationType: ISSUE_STATUS_NOTIFY_TYPE,
    route: {
      channel: "feishu",
      chatID: target.chatID,
      eventID: target.eventID,
      messageID: target.messageID,
      threadID: target.threadID
    }
  });
  return { queued: queued.queued, reason: queued.reason };
}

function safelyQueueDigestIntent(
  db: RunnerDatabase,
  intent: PiNotificationIntent,
  result: DigestQueueResult
): void {
  try {
    queueDigestIntent(db, intent, result);
  } catch (error) {
    markNotificationIntentRetry(db, intent, safeError(error));
    result.failed += 1;
  }
}

function queueDigestIntent(
  db: RunnerDatabase,
  intent: PiNotificationIntent,
  result: DigestQueueResult
): void {
  if (intent.target_channel !== "feishu" || intent.sent_outbox_id > 0) {
    result.skipped += 1;
    return;
  }
  const target = digestTarget(db, intent);
  if (!target) {
    markNotificationIntentRetry(db, intent, "missing_feishu_target");
    result.failed += 1;
    return;
  }
  const queued = queueExistingNotificationIntent(db, {
    content: formatRunGroupDigest(intent),
    deepLink: `/api/pi/guardian/run-groups/${encodeURIComponent(intent.run_group_id)}`,
    intent,
    notificationID: digestNotificationID(intent),
    notificationType: DIGEST_NOTIFY_TYPE,
    route: {
      channel: "feishu",
      chatID: target.chatID,
      eventID: target.eventID,
      messageID: target.messageID,
      threadID: target.threadID
    }
  });
  if (queued.queued) result.queued += 1;
  else result.skipped += 1;
}

function readyDigestIntents(db: RunnerDatabase, limit: number): PiNotificationIntent[] {
  return listPiNotificationIntents(db, { kind: "digest", state: "ready" })
    .slice(0, boundedLimit(limit));
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

function digestNotificationID(intent: PiNotificationIntent): string {
  return intent.idempotency_key || intent.id;
}

function boundedLimit(limit: number): number {
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, DEFAULT_DIGEST_LIMIT) : DEFAULT_DIGEST_LIMIT;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function issueNotificationID(issue: Issue): string {
  return ["todo", "in_progress"].includes(issue.status) ? `${issue.id}:start` : `${issue.id}:${issue.status}`;
}
