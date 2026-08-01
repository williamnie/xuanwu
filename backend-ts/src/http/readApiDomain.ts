import { createIssue } from "../db/repositories/issueCreate.ts";
import { deleteIssue, enqueueIssue, type IssueActionOptions } from "../db/repositories/issueActions.ts";
import {
  createIssueComment,
  type ListIssueEventsOptions
} from "../db/repositories/issueEvents.ts";
import { listAgentProfiles } from "../db/repositories/agentProfiles.ts";
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
  reviewHumanIssue
} from "../domain/review/humanReview.ts";
import { requestPiAcceptanceCycle } from "../runner/piAcceptanceCoordinator.ts";

export type IssueListFilter = {
  projectId: string;
  sourceSessionId: string;
  status: string;
};

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
      answerHumanReview: (id: number, body: Record<string, unknown>) => answerHumanReviewAndKickLoop(context, id, body),
      cancel: (id: number) => cancelIssue(context, id),
      comment: (id: number, body: Record<string, unknown>) => createIssueComment(context.database, id, body),
      create: (body: Record<string, unknown>) => createIssueAndKickLoop(context, body),
      delete: (id: number) => deleteIssue(context.database, id),
      enqueue: (id: number, options: IssueActionOptions) => actionAndKickLoop(context, enqueueIssue, id, options),
      events: (id: number, options: ListIssueEventsOptions) => listIssueEventsForApi(context.database, id, options),
      list: (filter: IssueListFilter) => publicIssues(context, listIssues(context.database, filter)),
      read: (id: number) => readIssue(context, id),
      requestHumanReview: (id: number, body: Record<string, unknown>) => (
        createHumanReviewRequest(context.database, id, body, { bus: context.bus })
      ),
      retry: (id: number, options: IssueActionOptions) => retryIssueAndKickLoop(context, id, options),
      runs: (id: number) => publicIssueRuns(listIssueRuns(context.database, id)),
      update: (id: number, body: Record<string, unknown>) => updateIssueAndKickLoop(context, id, body)
    },
    projects: {
      create: (body: Record<string, unknown>) => createAutomaticallyManagedProject(context.database, body),
      list: () => listProjects(context.database),
      read: (id: string) => mustGetProject(context.database, id),
      update: (id: string, body: Record<string, unknown>) => updateAutomaticallyManagedProject(context.database, id, body)
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
  const issue = createIssue(context.database, body);
  if (issue.status === "todo") kickAutoProject(context, issue.project_id);
  return issue;
}

async function updateIssueAndKickLoop(
  context: ReadApiContext,
  id: number,
  body: Record<string, unknown>
): Promise<Issue> {
  if (isStartIssuePatch(body)) return startIssueFromPatch(context, id, body);
  const current = getIssue(context.database, id);
  if (!current) throw new ProjectNotFoundError();
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
  publishIssueStatusChange(context, issue, body);
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

function startIssueFromPatch(context: ReadApiContext, id: number, body: Record<string, unknown>): Issue {
  const current = getIssue(context.database, id);
  if (!current) throw new ProjectNotFoundError();
  if (current.status === "in_progress" && hasOpenIssueRun(context.database, id)) return current;
  const issue = enqueueIssue(context.database, id, actionOptions(body));
  publishIssueStatusChange(context, issue, { status: issue.status });
  kickAutoProject(context, issue.project_id);
  return issue;
}

async function answerHumanReviewAndKickLoop(
  context: ReadApiContext,
  id: number,
  body: Record<string, unknown>
): Promise<Issue> {
  const issue = await reviewHumanIssue(context.database, id, body, {
    bus: context.bus,
    providers: context.providers
  });
  publishIssueStatusChange(context, issue, { status: issue.status });
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
  options: IssueActionOptions
): unknown {
  const output = action(context.database, id, options);
  if (isIssue(output)) publishIssueStatusChange(context, output, { status: output.status });
  if (isQueuedIssue(output)) kickAutoProject(context, output.project_id);
  return output;
}

async function cancelIssue(context: ReadApiContext, id: number): Promise<Issue> {
  const issue = await cancelIssueWithInterrupt(context.database, id, {
    bus: context.bus,
    interruptTimeoutMs: context.interruptTimeoutMs,
    providers: context.providers
  });
  kickAutoProject(context, issue.project_id);
  return issue;
}

async function retryIssueAndKickLoop(
  context: ReadApiContext,
  id: number,
  options: IssueActionOptions
): Promise<Issue> {
  const issue = await retryIssueWithInterrupt(context.database, id, options, {
    bus: context.bus,
    interruptTimeoutMs: context.interruptTimeoutMs,
    providers: context.providers
  });
  publishIssueStatusChange(context, issue, { status: issue.status });
  if (isQueuedIssue(issue)) kickAutoProject(context, issue.project_id, { forceOnce: true });
  return issue;
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

function publishIssueStatusChange(context: ReadApiContext, issue: Issue, body: Record<string, unknown>): void {
  if (!Object.hasOwn(body, "status")) return;
  context.bus?.publish({
    issueId: issue.id,
    payload: JSON.stringify({ status: issue.status }),
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
