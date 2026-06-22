import type { AppEvent, EventBus } from "../events/bus.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { createNotification } from "../db/repositories/notifications.ts";
import type { ProjectFinding } from "../pi/projectFindings.ts";
import { redactedUserVisibleText } from "../util/redact.ts";

export type PiNeedsUserNotificationPayload = {
  action_id?: string;
  diagnosis?: string;
  event: "pi.needs_user";
  issue_id: number;
  message: string;
  next_step?: string;
  occurred_at: string;
  project_id: string;
  project_name: string;
  provider?: string;
  reason: string;
  status: string;
  title: string;
};

export type PublishPiNeedsUserNotificationInput = {
  actionID?: string;
  bus?: Pick<EventBus, "publish">;
  database: RunnerDatabase;
  diagnosis?: string;
  issue: { id: number; project_id: string; status: string; title: string };
  message?: string;
  nextStep?: string;
  now?: Date;
  project: { id: string; name: string };
  provider?: string;
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

export function publishPiNeedsUserNotification(
  input: PublishPiNeedsUserNotificationInput
): PiNeedsUserNotificationPayload | null {
  const actionID = redactNotificationText(input.actionID ?? "");
  if (actionID !== "" && existingNeedsUserActionNotification(input.database, input.issue.id, actionID)) return null;
  const now = input.now ?? new Date();
  const payload = actionNotificationPayload(input, actionID, now.toISOString());
  if (!recordNotification(input.database, payload, now, 0)) return null;
  input.bus?.publish(notificationEvent(payload));
  return payload;
}

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

function actionNotificationPayload(
  input: PublishPiNeedsUserNotificationInput,
  actionID: string,
  occurredAt: string
): PiNeedsUserNotificationPayload {
  const diagnosis = redactNotificationText(input.diagnosis ?? "") || "needs_user";
  const nextStep = redactNotificationText(input.nextStep ?? "") || "请查看 Runner issue 并补充授权、凭证或下一步处理方式。";
  const provider = redactNotificationText(input.provider) || "unknown";
  return compactPayload({
    action_id: actionID || undefined,
    diagnosis,
    event: NEEDS_USER_EVENT,
    issue_id: input.issue.id,
    message: actionMessage(input.issue.id, provider, diagnosis, input.message, nextStep),
    next_step: nextStep,
    occurred_at: occurredAt,
    project_id: redactNotificationText(input.issue.project_id || input.project.id),
    project_name: redactNotificationText(input.project.name),
    provider,
    reason: diagnosis,
    status: redactNotificationText(input.issue.status),
    title: redactNotificationText(input.issue.title)
  });
}

function actionMessage(
  issueID: number,
  provider: string,
  diagnosis: string,
  message: unknown,
  nextStep: string
): string {
  return [
    `Pi：issue #${issueID} 需要用户介入。`,
    provider ? `Provider：${provider}` : "",
    `诊断：${diagnosis}`,
    `摘要：${redactNotificationText(message ?? "PI 判断当前无法继续自动恢复。")}`,
    `下一步：${nextStep}`
  ].filter(Boolean).join("\n");
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
  now: Date,
  cooldownMs?: number
): boolean {
  if (!database) return true;
  return createNotification(database, {
    event: payload.event,
    issueID: payload.issue_id,
    message: payload.message,
    payload: JSON.stringify(payload),
    projectID: payload.project_id,
    title: payload.title
  }, now, cooldownMs) !== null;
}

function redactNotificationText(value: unknown): string {
  return redactedUserVisibleText(typeof value === "string" ? value : "");
}

function existingNeedsUserActionNotification(db: RunnerDatabase, issueID: number, actionID: string): boolean {
  return db.sqlite.query<{ payload: string }, [number]>(
    "select payload from notifications where event='pi.needs_user' and issue_id=?"
  ).all(issueID).some((row) => parsePayload(row.payload).action_id === actionID);
}

function parsePayload(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function compactPayload(input: PiNeedsUserNotificationPayload): PiNeedsUserNotificationPayload {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as PiNeedsUserNotificationPayload;
}
