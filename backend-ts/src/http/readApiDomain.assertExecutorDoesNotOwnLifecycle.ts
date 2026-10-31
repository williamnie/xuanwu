import { createIssue, normalizeIdentifier } from "../db/repositories/issueCreate.ts";
import { deleteIssue } from "../db/repositories/issueActions.ts";
import { recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { getAgentProfile } from "../db/repositories/agentProfiles.ts";
import { getIssue, type Issue } from "../db/repositories/issues.ts";
import { getProject, ProjectNotFoundError } from "../db/repositories/projects.ts";
import { cancelIssueWithInterrupt } from "../runner/interrupt.ts";
import { kickAutoRunProjects, startProjectLoop, type ProjectLoopStartOptions } from "../runner/projectLoopManager.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { ReadApiContext } from "./readApiContext.ts";
import { readIssueDecisionProjection, reviewHumanIssue } from "../domain/review/humanReview.ts";
import { requestPiAcceptanceCycle } from "../runner/piAcceptanceCoordinator.ts";
import { publishPiNeedsUserNotification } from "../notifications/piNotifier.ts";
import type { IssueMutationActor } from "./readApiDomain.model.ts";

export class ManagedExecutorLifecycleMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedExecutorLifecycleMutationError";
  }
}

export const OPERATOR_ACTOR: IssueMutationActor = { kind: "operator", source: "internal", threadID: "" };

export function createIssueAndKickLoop(context: ReadApiContext, body: Record<string, unknown>): Issue {
  validateAgentProfileReference(context.database, body, "agent_profile_id");
  const issue = createIssue(context.database, body);
  if (issue.status === "todo") kickAutoProject(context, issue.project_id);
  return issue;
}

export function validateAgentProfileReference(
  database: RunnerDatabase,
  body: Record<string, unknown>,
  field: "agent_profile_id" | "default_agent_profile_id"
): void {
  if (!Object.hasOwn(body, field)) return;
  const profileID = normalizeIdentifier(body[field]);
  if (profileID !== "" && !getAgentProfile(database, profileID)) {
    throw new Error(`Agent Profile "${profileID}" was not found`);
  }
}

export async function answerHumanReviewAndKickLoop(
  context: ReadApiContext,
  id: number,
  body: Record<string, unknown>,
  actor: IssueMutationActor
): Promise<Issue> {
  const current = getIssue(context.database, id);
  if (!current) throw new ProjectNotFoundError();
  assertExecutorDoesNotOwnLifecycle(context, current, actor, "human_review_response");
  const issue = await reviewHumanIssue(context.database, id, body, {
    bus: context.bus,
    providers: context.providers
  });
  recordLifecycleControl(context.database, current, issue, actor, "human_review_response");
  publishIssueStatusChange(context, issue, { status: issue.status }, actor);
  if (
    issue.status === "in_progress"
    && readIssueDecisionProjection(context.database, issue.id).owner === "pi"
    && context.agenticClient?.decideIssueAcceptance
  ) {
    requestPiAcceptanceCycle({
      database: context.database,
      decideIssueAcceptance: context.agenticClient.decideIssueAcceptance.bind(context.agenticClient),
      issueID: issue.id,
      providers: context.providers,
      source: "human-review-resolved"
    });
  }
  if (shouldKickAfterWrite(issue.status)) kickAutoProject(context, issue.project_id);
  return issue;
}

export async function cancelIssue(context: ReadApiContext, id: number, actor: IssueMutationActor): Promise<Issue> {
  const current = getIssue(context.database, id);
  if (!current) throw new ProjectNotFoundError();
  assertExecutorDoesNotOwnLifecycle(context, current, actor, "cancel");
  const issue = await cancelIssueWithInterrupt(context.database, id, {
    bus: context.bus,
    interruptTimeoutMs: context.interruptTimeoutMs,
    providers: context.providers
  });
  recordLifecycleControl(context.database, current, issue, actor, "cancel");
  publishIssueStatusChange(context, issue, { status: issue.status }, actor);
  kickAutoProject(context, issue.project_id);
  return issue;
}

export function deleteIssueWithActor(context: ReadApiContext, id: number, actor: IssueMutationActor): void {
  const current = getIssue(context.database, id);
  if (!current) throw new ProjectNotFoundError();
  assertExecutorDoesNotOwnLifecycle(context, current, actor, "delete");
  deleteIssue(context.database, id);
}

export function assertExecutorDoesNotOwnLifecycle(
  context: ReadApiContext,
  issue: Issue,
  actor: IssueMutationActor,
  operation: string
): void {
  if (actor.kind !== "managed_executor") return;
  if (actor.threadID !== "" && issue.codex_thread_id !== actor.threadID) return;
  const runID = issue.latest_run?.id ?? "";
  recordIssueEvent(context.database, issue.id, "issue.executor_lifecycle_mutation_denied.v1", {
    actor: actorPayload(actor),
    issue_run_id: runID,
    operation,
    reason: actor.threadID === ""
      ? "managed executor identity was missing"
      : "the active executor cannot control its own Issue lifecycle"
  });
  const project = getProject(context.database, issue.project_id);
  publishPiNeedsUserNotification({
    actionID: `executor-lifecycle-denied:${issue.id}:${runID || "no-run"}:${operation}`,
    bus: context.bus,
    database: context.database,
    diagnosis: "executor_self_lifecycle_mutation_denied",
    issue,
    message: `Executor attempted to ${operation} its own Issue. Xuanwu denied the control-plane mutation and left lifecycle ownership with the Host and PI.`,
    nextStep: "请检查 Issue 中是否混入了创建期/triage 状态指令；当前 executor 应通过 RUNNER_OUTCOME 报告结果或阻塞。",
    project: { id: issue.project_id, name: project?.name ?? issue.project_id },
    provider: issue.latest_run?.provider ?? "",
    userFacingMessage: `玄武已阻止 Issue #${issue.id} 的 executor 修改自己的生命周期。\n` +
      `尝试动作：${operation}\n` +
      "Issue/Run 未被该请求取消；请检查任务正文中的创建期门禁，执行结果应交由 PI 判断。"
  });
  throw new ManagedExecutorLifecycleMutationError(
    `managed executor cannot ${operation} its own Issue #${issue.id}; report RUNNER_OUTCOME and let the Host/PI reconcile lifecycle`
  );
}

export function recordLifecycleControl(
  db: RunnerDatabase,
  before: Issue,
  after: Issue,
  actor: IssueMutationActor,
  operation: string
): void {
  if (before.status === after.status && operation !== "human_review_response" && operation !== "human_review_request") return;
  recordIssueEvent(db, before.id, "issue.lifecycle_control.v1", {
    actor: actorPayload(actor),
    after_status: after.status,
    before_status: before.status,
    issue_run_id: after.latest_run?.id ?? before.latest_run?.id ?? "",
    operation
  });
}

export function actorPayload(actor: IssueMutationActor): Record<string, string> {
  return {
    kind: actor.kind,
    source: actor.source,
    thread_id: actor.threadID
  };
}

export function kickAutoProject(
  context: ReadApiContext,
  projectID: string,
  options: ProjectLoopStartOptions = {}
): void {
  const project = getProject(context.database, projectID);
  if ((project?.auto_run ?? 0) !== 1) return;
  const runtime = { bus: context.bus, database: context.database, providers: context.providers };
  if (options.forceOnce === true) startProjectLoop(runtime, projectID, options);
  kickAutoRunProjects(runtime);
}

export function isQueuedIssue(value: unknown): value is Issue {
  return Boolean(value && typeof value === "object" && (value as Issue).status === "todo");
}

export function isIssue(value: unknown): value is Issue {
  return Boolean(value && typeof value === "object" && typeof (value as Issue).id === "number");
}

export function publishIssueStatusChange(
  context: ReadApiContext,
  issue: Issue,
  body: Record<string, unknown>,
  actor: IssueMutationActor = OPERATOR_ACTOR
): void {
  if (!Object.hasOwn(body, "status")) return;
  context.bus?.publish({
    issueId: issue.id,
    payload: JSON.stringify({ actor: actorPayload(actor), status: issue.status }),
    projectId: issue.project_id,
    type: "issue.status_changed"
  });
}

export const LOOP_RELEASE_STATUSES = new Set(["cancelled", "done", "failed", "todo"]);

export function shouldKickAfterWrite(status: string): boolean {
  return LOOP_RELEASE_STATUSES.has(status);
}
