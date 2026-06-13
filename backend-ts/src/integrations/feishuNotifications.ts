import type { RunnerDatabase } from "../db/database.ts";
import { createImReplyDraft, approveImReplyDraft } from "../db/repositories/imReplyOutbox.ts";
import { getIssue, type Issue } from "../db/repositories/issues.ts";
import { listExternalLinksByIssue, createExternalLink } from "../db/repositories/externalLinks.ts";
import { listAgentSessions } from "../db/repositories/agentSessions.ts";
import type { AppEvent, EventBus } from "../events/bus.ts";
import type { FeishuConnectorConfig } from "./feishu.ts";
import { createFeishuMessageClient } from "./feishuClient.ts";
import { dispatchFeishuOutbox, type FeishuMessageSender } from "../pi/imReplyOutboxDispatcher.ts";
import { redactSensitiveText } from "../util/redact.ts";

type QueueResult = { queued: boolean; reason: string };
type FeishuTarget = { chatID: string; eventID: number; messageID: string; threadID: string };

const FEISHU_SOURCE = "feishu";
const ISSUE_STATUS_NOTIFY_TYPE = "feishu_issue_status_notification";
const APPROVAL_NOTIFY_TYPE = "feishu_approval_notification";

export function attachFeishuNotificationObservers(input: {
  bus: Pick<EventBus, "observe">;
  config?: FeishuConnectorConfig;
  database: RunnerDatabase;
  sender?: FeishuMessageSender;
}): () => void {
  return input.bus.observe((event) => {
    try {
      if (event.type === "issue.status_changed" && event.issueId) {
        const result = queueFeishuIssueStatusNotification(input.database, event.issueId);
        dispatchIfQueued(input, result);
      }
      if (event.type === "codex.event" && event.method === "approval/requested") {
        const result = queueFeishuApprovalNotification(input.database, event);
        dispatchIfQueued(input, result);
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

export function queueFeishuIssueStatusNotification(db: RunnerDatabase, issueID: number): QueueResult {
  const issue = getIssue(db, issueID);
  if (!issue) return { queued: false, reason: "issue_not_found" };
  if (!["done", "failed", "pending_verification"].includes(issue.status)) return { queued: false, reason: "non_terminal" };
  const target = feishuTargetForIssue(db, issue.id);
  if (!target) return { queued: false, reason: "missing_feishu_link" };
  const notifyID = `${issue.id}:${issue.status}`;
  if (alreadyQueued(db, APPROVAL_NOTIFY_TYPE, notifyID) || alreadyQueued(db, ISSUE_STATUS_NOTIFY_TYPE, notifyID)) {
    return { queued: false, reason: "duplicate" };
  }
  createNotificationDraft(db, issue, target, {
    content: issueStatusText(issue),
    notifyID,
    type: ISSUE_STATUS_NOTIFY_TYPE
  });
  return { queued: true, reason: "queued" };
}

export function queueFeishuApprovalNotification(db: RunnerDatabase, event: AppEvent): QueueResult {
  if (event.method !== "approval/requested") return { queued: false, reason: "not_approval_request" };
  const parsed = approvalPayload(event);
  const approvalID = parsed.id || event.threadId || event.turnId;
  if (approvalID === "") return { queued: false, reason: "missing_approval_id" };
  if (alreadyQueued(db, APPROVAL_NOTIFY_TYPE, approvalID)) return { queued: false, reason: "duplicate" };
  const issue = issueForApproval(db, event);
  if (!issue) return { queued: false, reason: "missing_issue" };
  const target = feishuTargetForIssue(db, issue.id);
  if (!target) return { queued: false, reason: "missing_feishu_link" };
  createNotificationDraft(db, issue, target, {
    content: approvalText(issue, parsed.command, parsed.path),
    notifyID: approvalID,
    type: APPROVAL_NOTIFY_TYPE
  });
  return { queued: true, reason: "queued" };
}

function createNotificationDraft(
  db: RunnerDatabase,
  issue: Issue,
  target: FeishuTarget,
  input: { content: string; notifyID: string; type: string }
): void {
  const draft = createImReplyDraft(db, {
    content: input.content,
    created_by: "pi",
    external_event_id: target.eventID,
    issue_id: issue.id,
    risk: "low",
    source: FEISHU_SOURCE,
    status: "pending",
    target_chat_id: target.chatID,
    target_message_id: target.messageID,
    target_thread_id: target.threadID
  });
  approveImReplyDraft(db, draft.id);
  createExternalLink(db, {
    conversation_id: target.threadID || target.chatID,
    external_event_id: target.eventID,
    external_id: input.notifyID,
    external_type: input.type,
    issue_id: issue.id,
    project_id: issue.project_id,
    relationship: "notification",
    source: FEISHU_SOURCE
  });
}

function issueStatusText(issue: Issue): string {
  const title = issue.title || "任务";
  if (issue.status === "done") return `Pi：issue #${issue.id} 已完成：${title}`;
  if (issue.status === "pending_verification") return `Pi：issue #${issue.id} 已进入待验收：${title}`;
  return `Pi：issue #${issue.id} 执行失败：${title}${issue.error ? `；${safeText(issue.error)}` : ""}`;
}

function approvalText(issue: Issue, command: string, path: string): string {
  const detail = [command ? `命令：${command}` : "", path ? `路径：${path}` : ""].filter(Boolean).join("；");
  return `Pi：issue #${issue.id} 需要授权才能继续。${detail || "请到 Runner/Codex 授权面板处理。"}`;
}

function feishuTargetForIssue(db: RunnerDatabase, issueID: number): FeishuTarget | null {
  const link = listExternalLinksByIssue(db, issueID)
    .find((item) => item.source === FEISHU_SOURCE && item.external_type === "feishu_message");
  if (!link) return null;
  const message = db.sqlite.query<{ normalized_message_json: string }, [number]>(
    "select normalized_message_json from external_events where id=?"
  ).get(link.external_event_id);
  const normalized = parseObject(message?.normalized_message_json);
  const chatID = safeText(normalized.chat_id) || link.conversation_id;
  const messageID = safeText(normalized.message_id) || link.external_id;
  const threadID = safeText(normalized.thread_id) || safeText(normalized.root_id);
  if (chatID === "" && messageID === "") return null;
  return { chatID, eventID: link.external_event_id, messageID, threadID };
}

function alreadyQueued(db: RunnerDatabase, type: string, externalID: string): boolean {
  const row = db.sqlite.query<{ count: number }, [string, string]>(
    "select count(*) as count from external_links where source='feishu' and external_type=? and external_id=?"
  ).get(type, externalID);
  return (row?.count ?? 0) > 0;
}

function issueForApproval(db: RunnerDatabase, event: AppEvent): Issue | null {
  if (event.issueId) return getIssue(db, event.issueId);
  const threadID = safeText(event.threadId) || safeText(approvalPayload(event).threadID);
  if (threadID === "") return null;
  const session = listAgentSessions(db, { provider: safeText(event.provider) || "codex" })
    .find((item) => item.provider_session_id === threadID);
  return session?.issue_id ? getIssue(db, session.issue_id) : null;
}

function approvalPayload(event: AppEvent): { command: string; id: string; path: string; threadID: string } {
  const raw = parseObject(event.payload);
  const params = parseObject(raw.params);
  return {
    command: safeText(params.command || parseObject(params.item).command),
    id: safeText(raw.id || params.approvalId || params.itemId || params.callId),
    path: safeText(params.path || parseObject(params.item).path),
    threadID: safeText(params.threadId || params.conversationId)
  };
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
