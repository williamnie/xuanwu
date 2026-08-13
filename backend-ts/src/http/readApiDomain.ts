import { createIssue, normalizeIdentifier } from "../db/repositories/issueCreate.ts";
import { deleteIssue, enqueueIssue, type IssueActionOptions } from "../db/repositories/issueActions.ts";
import {
  createIssueComment,
  recordIssueEvent,
  type ListIssueEventsOptions
} from "../db/repositories/issueEvents.ts";
import { getAgentProfile, listAgentProfiles } from "../db/repositories/agentProfiles.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { auditIssueSkillIntents } from "../skills/intentAudit.ts";
import { getIssue, listIssueRuns, listIssues, type Issue, type IssueRun } from "../db/repositories/issues.ts";
import {
  getProject,
  listProjects,
  type Project,
  ProjectNotFoundError
} from "../db/repositories/projects.ts";
import { cancelIssueWithInterrupt, retryIssueWithInterrupt } from "../runner/interrupt.ts";
import { issueMcpRequirementSummary, type McpRequirementSummary } from "../mcp/requirements.ts";
import { kickAutoRunProjects, startProjectLoop, type ProjectLoopStartOptions } from "../runner/projectLoopManager.ts";
import { requestIssuePiAcceptance } from "../runner/piAcceptanceRequest.ts";
import {
  readProjectIssueDependencies,
  type IssueDependencyDiagnostic
} from "../domain/work/issueDependency.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { ReadApiContext } from "./readApiContext.ts";
import { listIssueEventsAsync } from "../db/asyncIssueEvents.ts";
import {
  createAutomaticallyManagedProject,
  updateAutomaticallyManagedProject
} from "../domain/project/automaticTakeover.ts";
import {
  createHumanReviewRequest,
  readIssueDecisionProjection,
  reopenIncorrectlyAcceptedHumanReview,
  reviewHumanIssue
} from "../domain/review/humanReview.ts";
import { requestPiAcceptanceCycle } from "../runner/piAcceptanceCoordinator.ts";
import { publishPiNeedsUserNotification } from "../notifications/piNotifier.ts";

export type IssueListFilter = {
  projectId: string;
  sourceSessionId: string;
  status: string;
};

export type IssueMutationActor = {
  kind: "managed_executor" | "operator";
  source: string;
  threadID: string;
};

export class ManagedExecutorLifecycleMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedExecutorLifecycleMutationError";
  }
}

const OPERATOR_ACTOR: IssueMutationActor = { kind: "operator", source: "internal", threadID: "" };

type IssueAction = (db: RunnerDatabase, id: number, options?: IssueActionOptions) => unknown;
type PublicIssueRun = Omit<IssueRun, "runtime_metadata_json">;
type PublicIssueRunMetadata = Record<string, unknown>;
type PublicIssueRunView = PublicIssueRun & {
  runtime_metadata: PublicIssueRunMetadata;
  service_tier: string;
  service_tier_source: string;
};
type PublicIssue = Omit<Issue, "latest_run"> & {
  decision: ReturnType<typeof readIssueDecisionProjection>;
  dependency: IssueDependencyDiagnostic;
  latest_run?: PublicIssueRunView;
  mcp_requirements: McpRequirementSummary;
};

export function createReadApiDomainHandlers(context: ReadApiContext) {
  return {
    auxiliary: {
      listAgentProfiles: () => listAgentProfiles(context.database)
    },
    issues: {
      answerHumanReview: (id: number, body: Record<string, unknown>, actor = OPERATOR_ACTOR) => (
        answerHumanReviewAndKickLoop(context, id, body, actor)
      ),
      cancel: (id: number, actor = OPERATOR_ACTOR) => cancelIssue(context, id, actor),
      comment: (id: number, body: Record<string, unknown>) => createIssueComment(context.database, id, body),
      create: (body: Record<string, unknown>) => createIssueAndKickLoop(context, body),
      delete: (id: number, actor = OPERATOR_ACTOR) => deleteIssueWithActor(context, id, actor),
      enqueue: (id: number, options: IssueActionOptions, actor = OPERATOR_ACTOR) => (
        actionAndKickLoop(context, enqueueIssue, id, options, actor, "enqueue")
      ),
      events: (id: number, options: ListIssueEventsOptions) => listIssueEventsForApi(context.database, id, options),
      list: (filter: IssueListFilter) => publicIssues(context, listIssues(context.database, filter)),
      read: (id: number) => readIssue(context, id),
      requestHumanReview: (id: number, body: Record<string, unknown>, actor = OPERATOR_ACTOR) => (
        requestHumanReviewWithActor(context, id, body, actor)
      ),
      retry: (id: number, options: IssueActionOptions, actor = OPERATOR_ACTOR) => (
        retryIssueAndKickLoop(context, id, options, actor)
      ),
      runs: (id: number) => publicIssueRuns(listIssueRuns(context.database, id)),
      update: (id: number, body: Record<string, unknown>, actor = OPERATOR_ACTOR) => (
        updateIssueAndKickLoop(context, id, body, actor)
      )
    },
    projects: {
      create: (body: Record<string, unknown>) => {
        validateAgentProfileReference(context.database, body, "default_agent_profile_id");
        return createAutomaticallyManagedProject(context.database, body);
      },
      list: () => listProjects(context.database),
      read: (id: string) => mustGetProject(context.database, id),
      update: (id: string, body: Record<string, unknown>) => {
        mustGetProject(context.database, id);
        validateAgentProfileReference(context.database, body, "default_agent_profile_id");
        return updateAutomaticallyManagedProject(context.database, id, body);
      }
    }
  };
}

function listIssueEventsForApi(
  db: RunnerDatabase,
  id: number,
  options: ListIssueEventsOptions
) {
  if (!getIssue(db, id)) throw new ProjectNotFoundError();
  return listIssueEventsAsync(db, id, { ...options, hydrateArtifacts: false });
}

export type ReadApiDomainHandlers = ReturnType<typeof createReadApiDomainHandlers>;

function createIssueAndKickLoop(context: ReadApiContext, body: Record<string, unknown>): Issue {
  validateAgentProfileReference(context.database, body, "agent_profile_id");
  const issue = createIssue(context.database, body);
  if (issue.status === "todo") kickAutoProject(context, issue.project_id);
  return issue;
}

async function updateIssueAndKickLoop(
  context: ReadApiContext,
  id: number,
  body: Record<string, unknown>,
  actor: IssueMutationActor
): Promise<Issue> {
  const current = getIssue(context.database, id);
  if (!current) throw new ProjectNotFoundError();
  validateAgentProfileReference(context.database, body, "agent_profile_id");
  if (Object.hasOwn(body, "status")) assertExecutorDoesNotOwnLifecycle(context, current, actor, "status_update");
  if (isStartIssuePatch(body)) return startIssueFromPatch(context, id, body, actor);
  const requestedStatus = stringBody(body.status);
  if (requestedStatus === "failed" || requestedStatus === "needs_user") {
    throw new Error(`${requestedStatus} 只能由 PI 语义决策写入`);
  }
  const issue = requestedStatus === "done"
    ? requestIssuePiAcceptance(context.database, id, {
      reason: "Issue PATCH requested done",
      source: "issue-patch-api"
    })
    : updateIssue(context.database, id, body);
  if (Object.hasOwn(body, "status")) recordLifecycleControl(context.database, current, issue, actor, "status_update");
  publishIssueStatusChange(context, issue, body, actor);
  if (
    requestedStatus === "done"
    && issue.status === "in_progress"
    && readIssueDecisionProjection(context.database, issue.id).owner === "pi"
    && context.agenticClient?.decideIssueAcceptance
  ) {
    requestPiAcceptanceCycle({
      database: context.database,
      decideIssueAcceptance: context.agenticClient.decideIssueAcceptance.bind(context.agenticClient),
      issueID: issue.id,
      providers: context.providers,
      source: "issue-done-claim"
    });
  }
  if (terminalForSkillAudit(issue.status)) safeAuditSkillIntents(context.database, issue.id);
  if (shouldKickAfterWrite(issue.status)) kickAutoProject(context, issue.project_id);
  return issue;
}

function validateAgentProfileReference(
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

function startIssueFromPatch(
  context: ReadApiContext,
  id: number,
  body: Record<string, unknown>,
  actor: IssueMutationActor
): Issue {
  const current = getIssue(context.database, id);
  if (!current) throw new ProjectNotFoundError();
  if (current.status === "in_progress" && hasOpenIssueRun(context.database, id)) return current;
  const issue = enqueueIssue(context.database, id, actionOptions(body));
  recordLifecycleControl(context.database, current, issue, actor, "start");
  publishIssueStatusChange(context, issue, { status: issue.status }, actor);
  kickAutoProject(context, issue.project_id);
  return issue;
}

async function answerHumanReviewAndKickLoop(
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

function actionAndKickLoop(
  context: ReadApiContext,
  action: IssueAction,
  id: number,
  options: IssueActionOptions,
  actor: IssueMutationActor,
  operation: string
): unknown {
  const current = getIssue(context.database, id);
  if (!current) throw new ProjectNotFoundError();
  assertExecutorDoesNotOwnLifecycle(context, current, actor, operation);
  const output = action(context.database, id, options);
  if (isIssue(output)) {
    recordLifecycleControl(context.database, current, output, actor, operation);
    publishIssueStatusChange(context, output, { status: output.status }, actor);
  }
  if (isQueuedIssue(output)) kickAutoProject(context, output.project_id);
  return output;
}

async function cancelIssue(context: ReadApiContext, id: number, actor: IssueMutationActor): Promise<Issue> {
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

async function retryIssueAndKickLoop(
  context: ReadApiContext,
  id: number,
  options: IssueActionOptions,
  actor: IssueMutationActor
): Promise<Issue> {
  const current = getIssue(context.database, id);
  if (!current) throw new ProjectNotFoundError();
  assertExecutorDoesNotOwnLifecycle(context, current, actor, "retry");
  const issue = await retryIssueWithInterrupt(context.database, id, options, {
    bus: context.bus,
    interruptTimeoutMs: context.interruptTimeoutMs,
    providers: context.providers
  });
  recordLifecycleControl(context.database, current, issue, actor, "retry");
  publishIssueStatusChange(context, issue, { status: issue.status }, actor);
  if (isQueuedIssue(issue)) kickAutoProject(context, issue.project_id, { forceOnce: true });
  return issue;
}

function deleteIssueWithActor(context: ReadApiContext, id: number, actor: IssueMutationActor): void {
  const current = getIssue(context.database, id);
  if (!current) throw new ProjectNotFoundError();
  assertExecutorDoesNotOwnLifecycle(context, current, actor, "delete");
  deleteIssue(context.database, id);
}

function requestHumanReviewWithActor(
  context: ReadApiContext,
  id: number,
  body: Record<string, unknown>,
  actor: IssueMutationActor
) {
  const current = getIssue(context.database, id);
  if (!current) throw new ProjectNotFoundError();
  assertExecutorDoesNotOwnLifecycle(context, current, actor, "human_review_request");
  const request = Object.hasOwn(body, "reopen_accepted_request_id")
    ? reopenIncorrectlyAcceptedHumanReview(context.database, id, body, { bus: context.bus })
    : createHumanReviewRequest(context.database, id, body, { bus: context.bus });
  const updated = getIssue(context.database, id) ?? current;
  recordLifecycleControl(context.database, current, updated, actor, "human_review_request");
  if (updated.status !== current.status) {
    publishIssueStatusChange(context, updated, { status: updated.status }, actor);
  }
  return request;
}

function assertExecutorDoesNotOwnLifecycle(
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

function recordLifecycleControl(
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

function actorPayload(actor: IssueMutationActor): Record<string, string> {
  return {
    kind: actor.kind,
    source: actor.source,
    thread_id: actor.threadID
  };
}

function kickAutoProject(
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

function isQueuedIssue(value: unknown): value is Issue {
  return Boolean(value && typeof value === "object" && (value as Issue).status === "todo");
}

function isIssue(value: unknown): value is Issue {
  return Boolean(value && typeof value === "object" && typeof (value as Issue).id === "number");
}

function publishIssueStatusChange(
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

function readIssue(context: ReadApiContext, id: number): PublicIssue {
  const issue = getIssue(context.database, id);
  if (!issue) throw new ProjectNotFoundError();
  const dependency = readProjectIssueDependencies(context.database, issue.project_id).get(issue.id);
  if (!dependency) throw new ProjectNotFoundError();
  return publicIssue(context.database, issue, getProject(context.database, issue.project_id), dependency);
}

function publicIssues(context: ReadApiContext, issues: Issue[]): PublicIssue[] {
  const projects = projectsByID(listProjects(context.database));
  const dependencies = new Map([...new Set(issues.map((issue) => issue.project_id))].map((projectID) => (
    [projectID, readProjectIssueDependencies(context.database, projectID)]
  )));
  return issues.map((issue) => {
    const dependency = dependencies.get(issue.project_id)?.get(issue.id);
    if (!dependency) throw new ProjectNotFoundError();
    return publicIssue(context.database, issue, projects.get(issue.project_id) ?? null, dependency);
  });
}

function publicIssue(
  db: RunnerDatabase,
  issue: Issue,
  project: Project | null,
  dependency: IssueDependencyDiagnostic
): PublicIssue {
  const mcp_requirements = issueMcpRequirementSummary(issue, project);
  const decision = readIssueDecisionProjection(db, issue.id);
  if (!issue.latest_run) return { ...issue, decision, dependency, mcp_requirements } as PublicIssue;
  return { ...issue, decision, dependency, latest_run: publicIssueRun(issue.latest_run), mcp_requirements };
}

function publicIssueRuns(runs: IssueRun[]): PublicIssueRunView[] {
  return runs.map(publicIssueRun);
}

function publicIssueRun(run: IssueRun): PublicIssueRunView {
  const { runtime_metadata_json, ...publicRun } = run;
  const metadata = parseRuntimeMetadata(runtime_metadata_json);
  return {
    ...publicRun,
    runtime_metadata: metadata,
    service_tier: stringFromMetadata(metadata.service_tier),
    service_tier_source: stringFromMetadata(metadata.service_tier_source)
  };
}

function projectsByID(projects: Project[]): Map<string, Project> {
  return new Map(projects.map((project) => [project.id, project]));
}

function mustGetProject(db: RunnerDatabase, id: string): Project {
  const project = getProject(db, id);
  if (!project) throw new ProjectNotFoundError();
  return project;
}

function actionOptions(body: Record<string, unknown>): IssueActionOptions {
  return Object.hasOwn(body, "service_tier")
    ? { serviceTier: stringBody(body.service_tier), serviceTierProvided: true }
    : {};
}

function isStartIssuePatch(body: Record<string, unknown>): boolean {
  return typeof body.status === "string" && body.status.trim() === "in_progress";
}

function hasOpenIssueRun(db: RunnerDatabase, issueID: number): boolean {
  return listIssueRuns(db, issueID).some((run) => run.ended_at === "");
}

function parseRuntimeMetadata(value: string): PublicIssueRunMetadata {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as PublicIssueRunMetadata : {};
  } catch {
    return {};
  }
}

function stringFromMetadata(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringBody(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const LOOP_RELEASE_STATUSES = new Set(["cancelled", "done", "failed", "todo"]);

function shouldKickAfterWrite(status: string): boolean {
  return LOOP_RELEASE_STATUSES.has(status);
}

function terminalForSkillAudit(status: string): boolean {
  return ["cancelled", "done", "failed"].includes(status);
}

function safeAuditSkillIntents(db: RunnerDatabase, issueID: number): void {
  try { auditIssueSkillIntents(db, issueID); } catch {}
}
