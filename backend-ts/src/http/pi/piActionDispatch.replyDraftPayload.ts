import type { RunnerDatabase } from "../../db/database.ts";
import { enqueueIssue } from "../../db/repositories/issueActions.ts";
import { getIssue, listIssues } from "../../db/repositories/issues.ts";
import type { PiAction } from "../../db/repositories/pi.ts";
import { getProject, type Project } from "../../db/repositories/projects.ts";
import { startProjectLoop as defaultStartProjectLoop, type ProjectLoopStartOptions } from "../../runner/projectLoopManager.ts";
import { isExecutorProviderId } from "../../providers/types.ts";
import { isRunnerChatSource } from "../../pi/runnerTools/runnerChatAuthorization.ts";
import { executeIssueStatusUpdate, type IssueStatusUpdateInput } from "../../pi/runnerTools/runnerIssueStatusActions.ts";
import { cleanString, objectValue } from "../../util/values.ts";
import { providersForProjectID } from "../../nodes/remoteExecution.ts";
import type { PiActionDispatchContext } from "./piActionDispatch.model.ts";

export const PI_ACTION_DISPATCH_TYPES = new Set([
  "agent.executor_assign",
  "agent.workflow_request",
  "human_review.respond",
  "issue.acceptance_request",
  "issue.cancel",
  "issue.comment",
  "issue.create",
  "issue.delete",
  "issue.enqueue",
  "issue.schedule_enqueue",
  "issue.state_repair",
  "issue.status_update",
  "issue_completion_watch.cancel",
  "issue_completion_watch.create",
  "notification.preference.update",
  "runner.settings_update",
  "run.interrupt",
  "run.resume",
  "run.retry",
  "session.steer",
  "system.restart",
  "work.cancel",
  "work.create",
  "work.enqueue",
  "work.retry",
  "work.update"
]);

export function hasPiActionDispatcher(actionType: string): boolean {
  return PI_ACTION_DISPATCH_TYPES.has(actionType);
}

export async function updateIssueStatusesAndStartAutoRun(
  context: PiActionDispatchContext,
  action: PiAction,
  input: IssueStatusUpdateInput
): Promise<unknown> {
  const result = await executeIssueStatusUpdate(context.database, input, {
    bus: context.bus,
    onExecutionRequested: (projectID) => startEnqueuedProjectLoop(context, action, projectID),
    providers: context.providers
  });
  if (input.status !== "in_progress" && input.status !== "todo") {
    startAutoRunProjectLoop(context, result.project_id);
  }
  return result;
}

export function issueStatusUpdateInput(payload: Record<string, unknown>): IssueStatusUpdateInput {
  const status = cleanString(payload.status);
  if (status !== "triage" && status !== "todo" && status !== "in_progress" &&
    status !== "needs_user" && status !== "done" && status !== "failed" && status !== "cancelled") {
    throw new Error("status is invalid");
  }
  const reason = requiredPayloadText(payload, "reason");
  return {
    error: cleanString(payload.error),
    issue_ids: positiveIDList(payload.issue_ids),
    reason,
    status
  };
}

export function requiredPayloadText(payload: Record<string, unknown>, key: string): string {
  const value = cleanString(payload[key]);
  if (value === "") throw new Error(`${key} is required`);
  return value;
}

export function actionPayload(action: PiAction, payload: Record<string, unknown>): Record<string, unknown> {
  return { ...payload, action_id: action.id, decision_id: action.guardian_decision_id, idempotency_key: action.idempotency_key };
}

export function issueCreatePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const description = cleanString(payload.description) || cleanString(payload.body);
  return { ...payload, description, status: cleanString(payload.status) || "triage" };
}

export function lookupIssueStatus(db: RunnerDatabase, payload: Record<string, unknown>): Record<string, unknown> {
  const issueID = positiveInputID(payload.issue_id);
  if (issueID) return { item: getIssue(db, issueID) };
  const projectID = cleanString(payload.project_id);
  const status = cleanString(payload.status);
  const query = cleanString(payload.query).toLowerCase();
  const items = listIssues(db, { projectId: projectID, status })
    .filter((issue) => query === "" || issue.title.toLowerCase().includes(query) ||
      issue.description.toLowerCase().includes(query))
    .slice(0, 10);
  return { items, query };
}

export function replyDraftPayload(actionPayload: Record<string, unknown>, action: PiAction): Record<string, unknown> {
  const text = cleanString(actionPayload.content) || cleanString(actionPayload.draft) ||
    cleanString(actionPayload.text) || cleanString(actionPayload.message);
  return {
    approval_action_id: action.id,
    content: text,
    created_by: cleanString(actionPayload.created_by) || "pi_action",
    external_event_id: positiveInputID(actionPayload.external_event_id) || 0,
    issue_id: positiveInputID(actionPayload.issue_id) || action.issue_id || 0,
    risk: cleanString(actionPayload.risk) || action.risk_level,
    source: cleanString(actionPayload.source) || action.source,
    target_chat_id: cleanString(actionPayload.target_chat_id),
    target_message_id: cleanString(actionPayload.target_message_id),
    target_thread_id: cleanString(actionPayload.target_thread_id)
  };
}

export function enqueueIssueAndStartAutoRun(context: PiActionDispatchContext, action: PiAction, issueID: number): unknown {
  const issue = enqueueIssue(context.database, issueID);
  startEnqueuedProjectLoop(context, action, issue.project_id);
  return issue;
}

export function startAutoRunProjectLoop(context: PiActionDispatchContext, projectID: string): void {
  startProjectLoopWhenAllowed(context, projectID);
}

export function startEnqueuedProjectLoop(
  context: PiActionDispatchContext,
  action: PiAction,
  projectID: string
): void {
  const options = runnerChatAction(action) ? { forceOnce: true } : undefined;
  startProjectLoopWhenAllowed(context, projectID, options);
}

export function startProjectLoopWhenAllowed(
  context: PiActionDispatchContext,
  projectID: string,
  options?: ProjectLoopStartOptions
): void {
  const project = getProject(context.database, projectID);
  const providerID = project?.provider ?? "";
  if (!project || !isExecutorProviderId(providerID)) return;
  if (!providersForProjectID(context.database, context.providers, project.id)?.[providerID]?.capabilities.includes("issue_execution")) return;
  if (!shouldStartProjectLoop(project, options)) return;
  const starter = context.startProjectLoop ?? defaultStartProjectLoop;
  starter({ bus: context.bus, database: context.database, providers: context.providers }, project.id, options);
}

export function shouldStartProjectLoop(project: Project, options?: ProjectLoopStartOptions): boolean {
  return options?.forceOnce === true || project.auto_run === 1;
}

export function runnerChatAction(action: PiAction): boolean {
  return isRunnerChatSource(action.source) || action.conversation_id.startsWith("feishu-");
}

export function parsePayload(action: PiAction): Record<string, unknown> {
  try {
    const value = JSON.parse(action.payload_json || "{}") as unknown;
    return objectValue(value);
  } catch {
    throw new Error("PI action payload_json is invalid");
  }
}

export function positivePayloadID(payload: Record<string, unknown>, key: string): number {
  const id = payload[key];
  if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return id;
  throw new Error(`${key} is required`);
}

export function positiveInputID(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  const parsed = Number.parseInt(cleanString(value), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function positiveIDList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  if (value.length > 40) throw new Error("issue_ids supports at most 40 items");
  const ids = value.map(positiveInputID);
  if (ids.some((id) => id === undefined)) throw new Error("issue_ids must contain positive integers");
  return [...new Set(ids.filter((id): id is number => id !== undefined))];
}
