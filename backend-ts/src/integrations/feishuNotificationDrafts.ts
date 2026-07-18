import type { RunnerDatabase } from "../db/database.ts";
import type { Issue } from "../db/repositories/issues.ts";
import {
  alreadyQueuedNotification,
  queueNotificationOutbox
} from "../notifications/notificationOutbox.ts";
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
): { outboxID: number } {
  const queued = queueNotificationOutbox(db, {
    approvalActionID: safeText(input.approvalActionID),
    channel: FEISHU_SOURCE,
    content: input.content,
    createdBy: "pi",
    issueID: issue.id,
    notificationID: input.notifyID,
    notificationType: input.type,
    projectID: issue.project_id,
    target
  });
  if (!queued.queued) throw new Error("Feishu notification already queued");
  return { outboxID: queued.outboxID };
}

export function alreadyQueuedFeishuNotification(db: RunnerDatabase, type: string, externalID: string): boolean {
  return alreadyQueuedNotification(db, FEISHU_SOURCE, type, externalID);
}

function safeText(value: unknown): string {
  return typeof value === "string" ? redactSensitiveText(value).trim() : "";
}
