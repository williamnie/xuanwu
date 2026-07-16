import { createIssue } from "../db/repositories/issueCreate.ts";
import { deleteIssue, enqueueIssue, type IssueActionOptions } from "../db/repositories/issueActions.ts";
import {
  createIssueComment,
  listIssueEvents,
  type ListIssueEventsOptions
} from "../db/repositories/issueEvents.ts";
import { listAgentProfiles } from "../db/repositories/agentProfiles.ts";
import { listIssueTemplates } from "../db/repositories/issueTemplates.ts";
import { listCronTasks } from "../db/repositories/cronTasks.ts";
import { reviewIssueVerification } from "../db/repositories/issueVerification.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { auditIssueSkillIntents } from "../skills/intentAudit.ts";
import { getIssue, listIssueRuns, listIssues, type Issue, type IssueRun } from "../db/repositories/issues.ts";
import {
  createProject,
  getProject,
  listProjects,
  type Project,
  ProjectNotFoundError,
  updateProject
} from "../db/repositories/projects.ts";
import { cancelIssueWithInterrupt, retryIssueWithInterrupt } from "../runner/interrupt.ts";
import { issueMcpRequirementSummary, type McpRequirementSummary } from "../mcp/requirements.ts";
import { startProjectLoop } from "../runner/projectLoopManager.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { ReadApiContext } from "./readApiContext.ts";

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
  latest_run?: PublicIssueRunView;
  mcp_requirements: McpRequirementSummary;
};

export function createReadApiDomainHandlers(context: ReadApiContext) {
  return {
    auxiliary: {
      listAgentProfiles: () => listAgentProfiles(context.database),
      listCronTasks: () => listCronTasks(context.database),
      listIssueTemplates: () => listIssueTemplates(context.database)
    },
    issues: {
      cancel: (id: number) => cancelIssue(context, id),
      comment: (id: number, body: Record<string, unknown>) => createIssueComment(context.database, id, body),
      create: (body: Record<string, unknown>) => createIssueAndKickLoop(context, body),
      delete: (id: number) => deleteIssue(context.database, id),
      enqueue: (id: number, options: IssueActionOptions) => actionAndKickLoop(context, enqueueIssue, id, options),
      events: (id: number, options: ListIssueEventsOptions) => listIssueEvents(context.database, id, options),
      list: (filter: IssueListFilter) => publicIssues(context, listIssues(context.database, filter)),
      read: (id: number) => readIssue(context, id),
      retry: (id: number, options: IssueActionOptions) => retryIssueAndKickLoop(context, id, options),
      runs: (id: number) => publicIssueRuns(listIssueRuns(context.database, id)),
      update: (id: number, body: Record<string, unknown>) => updateIssueAndKickLoop(context, id, body),
      verify: (id: number, body: Record<string, unknown>) => reviewIssueVerificationAndKickLoop(context, id, body)
    },
    projects: {
      create: (body: Record<string, unknown>) => createProject(context.database, body),
      list: () => listProjects(context.database),
      read: (id: string) => mustGetProject(context.database, id),
      update: (id: string, body: Record<string, unknown>) => updateProject(context.database, id, body)
    }
  };
}

export type ReadApiDomainHandlers = ReturnType<typeof createReadApiDomainHandlers>;

function createIssueAndKickLoop(context: ReadApiContext, body: Record<string, unknown>): Issue {
  const issue = createIssue(context.database, body);
  if (issue.status === "todo") kickAutoProject(context, issue.project_id);
  return issue;
}

function updateIssueAndKickLoop(context: ReadApiContext, id: number, body: Record<string, unknown>): Issue {
  if (isStartIssuePatch(body)) return startIssueFromPatch(context, id, body);
  const issue = updateIssue(context.database, id, body);
  publishIssueStatusChange(context, issue, body);
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

function reviewIssueVerificationAndKickLoop(
  context: ReadApiContext,
  id: number,
  body: Record<string, unknown>
): Issue {
  const issue = reviewIssueVerification(context.database, id, body);
  publishIssueStatusChange(context, issue, { status: issue.status });
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
  if (isQueuedIssue(issue)) kickAutoProject(context, issue.project_id);
  return issue;
}

function kickAutoProject(context: ReadApiContext, projectID: string): void {
  const project = getProject(context.database, projectID);
  if ((project?.auto_run ?? 0) !== 1) return;
  startProjectLoop({ bus: context.bus, database: context.database, providers: context.providers }, projectID);
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
  return publicIssue(issue, getProject(context.database, issue.project_id));
}

function publicIssues(context: ReadApiContext, issues: Issue[]): PublicIssue[] {
  const projects = projectsByID(listProjects(context.database));
  return issues.map((issue) => publicIssue(issue, projects.get(issue.project_id) ?? null));
}

function publicIssue(issue: Issue, project: Project | null): PublicIssue {
  const mcp_requirements = issueMcpRequirementSummary(issue, project);
  if (!issue.latest_run) return { ...issue, mcp_requirements } as PublicIssue;
  return { ...issue, latest_run: publicIssueRun(issue.latest_run), mcp_requirements };
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

const LOOP_RELEASE_STATUSES = new Set(["cancelled", "done", "failed", "pending_verification", "todo"]);

function shouldKickAfterWrite(status: string): boolean {
  return LOOP_RELEASE_STATUSES.has(status);
}

function terminalForSkillAudit(status: string): boolean {
  return ["cancelled", "done", "failed", "pending_verification"].includes(status);
}

function safeAuditSkillIntents(db: RunnerDatabase, issueID: number): void {
  try { auditIssueSkillIntents(db, issueID); } catch {}
}
