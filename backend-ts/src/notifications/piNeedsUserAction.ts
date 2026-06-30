import type { RunnerDatabase } from "../db/database.ts";
import { createIssueComment, listIssueEvents } from "../db/repositories/issueEvents.ts";
import { getIssue, type Issue } from "../db/repositories/issues.ts";
import type { PiAction } from "../db/repositories/pi.ts";
import { getProject } from "../db/repositories/projects.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import type { EventBus } from "../events/bus.ts";
import { redactedUserVisibleText } from "../util/redact.ts";
import { publishPiNeedsUserNotification } from "./piNotifier.ts";

export type PiNeedsUserActionContext = {
  bus?: Pick<EventBus, "publish">;
  database: RunnerDatabase;
};

export function dispatchNeedsUserEscalation(
  context: PiNeedsUserActionContext,
  action: PiAction,
  payload: Record<string, unknown>
): unknown {
  const issueID = positivePayloadID(payload, "issue_id");
  const issue = requireIssue(context.database, issueID);
  const project = getProject(context.database, issue.project_id);
  const published = publishPiNeedsUserNotification({
    actionID: action.id,
    bus: context.bus,
    database: context.database,
    diagnosis: cleanString(payload.diagnosis_code) || cleanString(payload.reason) || action.rationale,
    issue,
    message: cleanString(payload.body) || cleanString(payload.message),
    nextStep: cleanString(payload.next_step) || cleanString(payload.nextStep),
    project: { id: issue.project_id, name: project?.name ?? issue.project_id },
    provider: cleanString(payload.provider)
  });
  const body = published?.message ?? needsUserCommentBody(action, issue, payload);
  const released = releaseNeedsUserSlot(context.database, issue, payload);
  if (hasNeedsUserComment(context.database, issueID, action.id)) {
    return { comment: null, notification: published, released, skipped_comment: "duplicate" };
  }
  const comment = createIssueComment(context.database, issueID, {
    author: "agent",
    body: `${body}\nAction：${redactActionID(action.id)}`
  });
  return { comment, notification: published, released };
}

function requireIssue(db: RunnerDatabase, issueID: number): Issue {
  const issue = getIssue(db, issueID);
  if (!issue) throw new Error("issue not found");
  return issue;
}

function needsUserCommentBody(action: PiAction, issue: Issue, payload: Record<string, unknown>): string {
  const provider = redactCommentText(payload.provider);
  const diagnosis = redactCommentText(payload.diagnosis_code) || redactCommentText(payload.reason) ||
    redactCommentText(action.rationale) || "needs_user";
  const message = redactCommentText(payload.body) || redactCommentText(payload.message) || "PI 判断当前无法继续自动恢复。";
  const nextStep = redactCommentText(payload.next_step) || redactCommentText(payload.nextStep) ||
    "请查看 Runner issue 并补充授权、凭证或下一步处理方式。";
  return [
    `Pi：issue #${issue.id} 需要用户介入。`,
    provider ? `Provider：${provider}` : "",
    `诊断：${diagnosis}`,
    `摘要：${message}`,
    `下一步：${nextStep}`
  ].filter(Boolean).join("\n");
}

function releaseNeedsUserSlot(db: RunnerDatabase, issue: Issue, payload: Record<string, unknown>): Issue | null {
  if (issue.status !== "in_progress") return null;
  return updateIssue(db, issue.id, {
    error: needsUserIssueError(payload),
    status: "failed"
  });
}

function needsUserIssueError(payload: Record<string, unknown>): string {
  const diagnosis = redactCommentText(payload.diagnosis_code) || redactCommentText(payload.reason) || "needs_user";
  const message = redactCommentText(payload.message) || redactCommentText(payload.body) || "PI 判断当前无法继续自动恢复。";
  const nextStep = redactCommentText(payload.next_step) || redactCommentText(payload.nextStep);
  return [
    `needs_user: ${diagnosis}`,
    message,
    nextStep ? `下一步：${nextStep}` : ""
  ].filter(Boolean).join("\n");
}

function hasNeedsUserComment(db: RunnerDatabase, issueID: number, actionID: string): boolean {
  const marker = `Action：${redactActionID(actionID)}`;
  return listIssueEvents(db, issueID).some((event) => event.type === "issue.comment" && event.payload.includes(marker));
}

function positivePayloadID(payload: Record<string, unknown>, key: string): number {
  const id = payload[key];
  if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return id;
  throw new Error(`${key} is required`);
}

function redactActionID(value: unknown): string {
  return redactCommentText(value) || "needs_user.escalate";
}

function redactCommentText(value: unknown): string {
  return redactedUserVisibleText(cleanString(value));
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
