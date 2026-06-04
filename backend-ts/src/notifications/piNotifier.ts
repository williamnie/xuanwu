import type { AppEvent, EventBus } from "../events/bus.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { createNotification } from "../db/repositories/notifications.ts";
import type { ProjectFinding } from "../pi/projectFindings.ts";
import { redactSensitiveText } from "../util/redact.ts";

export type PiNeedsUserNotificationPayload = {
  event: "pi.needs_user";
  issue_id: number;
  message: string;
  occurred_at: string;
  project_id: string;
  project_name: string;
  reason: string;
  status: string;
  title: string;
};

export type PublishNeedsUserFindingNotificationsInput = {
  bus?: EventBus;
  database?: RunnerDatabase;
  findings: ProjectFinding[];
  notifyOnNeedsUser: boolean;
  now?: Date;
  project: { id: string; name: string };
};

const NEEDS_USER_EVENT = "pi.needs_user";
const ABSOLUTE_PATH_PATTERN = /(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g;

export function publishNeedsUserFindingNotifications(
  input: PublishNeedsUserFindingNotificationsInput
): PiNeedsUserNotificationPayload[] {
  if (!input.notifyOnNeedsUser) return [];
  const now = input.now ?? new Date();
  const payloads: PiNeedsUserNotificationPayload[] = [];
  for (const finding of input.findings.filter(isNeedsUserFinding)) {
    const payload = notificationPayload(input.project, finding, now.toISOString());
    if (!recordNotification(input.database, payload, now)) continue;
    payloads.push(payload);
    input.bus?.publish(notificationEvent(payload));
  }
  return payloads;
}

function isNeedsUserFinding(finding: ProjectFinding): boolean {
  return finding.notification?.type === NEEDS_USER_EVENT || finding.category === "needs_user";
}

function notificationPayload(
  project: PublishNeedsUserFindingNotificationsInput["project"],
  finding: ProjectFinding,
  occurredAt: string
): PiNeedsUserNotificationPayload {
  return {
    event: NEEDS_USER_EVENT,
    issue_id: finding.issue_id,
    message: redactNotificationText(finding.notification?.message || finding.message),
    occurred_at: occurredAt,
    project_id: redactNotificationText(project.id),
    project_name: redactNotificationText(project.name),
    reason: redactNotificationText(finding.reason),
    status: redactNotificationText(finding.status),
    title: redactNotificationText(finding.title)
  };
}

function notificationEvent(payload: PiNeedsUserNotificationPayload): AppEvent {
  return {
    type: NEEDS_USER_EVENT,
    issueId: payload.issue_id,
    projectId: payload.project_id,
    status: payload.status,
    text: payload.message,
    payload: JSON.stringify(payload),
    created_at: payload.occurred_at
  };
}

function recordNotification(
  database: RunnerDatabase | undefined,
  payload: PiNeedsUserNotificationPayload,
  now: Date
): boolean {
  if (!database) return true;
  return createNotification(database, {
    event: payload.event,
    issueID: payload.issue_id,
    message: payload.message,
    payload: JSON.stringify(payload),
    projectID: payload.project_id,
    title: payload.title
  }, now) !== null;
}

function redactNotificationText(value: string): string {
  return redactSensitiveText(value).replace(ABSOLUTE_PATH_PATTERN, "[redacted-path]");
}
