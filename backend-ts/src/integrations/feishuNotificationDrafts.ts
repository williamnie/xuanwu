import type { RunnerDatabase } from "../db/database.ts";
import { createExternalLink } from "../db/repositories/externalLinks.ts";
import { approveImReplyDraft, createImReplyDraft } from "../db/repositories/imReplyOutbox.ts";
import type { Issue } from "../db/repositories/issues.ts";
import { redactSensitiveText } from "../util/redact.ts";
import type { FeishuTarget } from "./feishuNotificationTargets.ts";

type NotificationIssue = Pick<Issue, "id" | "project_id">;
type DraftInput = { approvalActionID?: string; content: string; notifyID: string; type: string };

const FEISHU_SOURCE = "feishu";

export function createFeishuNotificationDraft(
  db: RunnerDatabase,
  issue: NotificationIssue,
  target: FeishuTarget,
  input: DraftInput
): void {
  const draft = createImReplyDraft(db, {
    content: input.content,
    created_by: "pi",
    external_event_id: target.eventID,
    issue_id: issue.id,
    risk: "low",
    source: FEISHU_SOURCE,
    status: "pending",
    approval_action_id: safeText(input.approvalActionID),
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

export function alreadyQueuedFeishuNotification(db: RunnerDatabase, type: string, externalID: string): boolean {
  const row = db.sqlite.query<{ count: number }, [string, string]>(
    "select count(*) as count from external_links where source='feishu' and external_type=? and external_id=?"
  ).get(type, externalID);
  return (row?.count ?? 0) > 0;
}

function safeText(value: unknown): string {
  return typeof value === "string" ? redactSensitiveText(value).trim() : "";
}
