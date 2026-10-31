import { enqueueIssue, type IssueActionOptions } from "../db/repositories/issueActions.ts";
import { type ListIssueEventsOptions } from "../db/repositories/issueEvents.ts";
import { auditIssueSkillIntents } from "../skills/intentAudit.ts";
import { getIssue, listIssueRuns, type Issue, type IssueRun } from "../db/repositories/issues.ts";
import { getProject, listProjects, type Project, ProjectNotFoundError } from "../db/repositories/projects.ts";
import { retryIssueWithInterrupt } from "../runner/interrupt.ts";
import { issueMcpRequirementSummary } from "../mcp/requirements.ts";
import { readProjectIssueDependencies, type IssueDependencyDiagnostic } from "../domain/work/issueDependency.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { ReadApiContext } from "./readApiContext.ts";
import { listIssueEventsAsync } from "../db/asyncIssueEvents.ts";
import { createHumanReviewRequest, readIssueDecisionProjection, reopenIncorrectlyAcceptedHumanReview } from "../domain/review/humanReview.ts";
import { cleanString } from "../util/values.ts";
import type { IssueMutationActor, IssueAction, PublicIssue, PublicIssueRunView, PublicIssueRunMetadata } from "./readApiDomain.model.ts";
import { recordLifecycleControl, publishIssueStatusChange, kickAutoProject, assertExecutorDoesNotOwnLifecycle, isIssue, isQueuedIssue } from "./readApiDomain.assertExecutorDoesNotOwnLifecycle.ts";

export function listIssueEventsForApi(
  db: RunnerDatabase,
  id: number,
  options: ListIssueEventsOptions
) {
  if (!getIssue(db, id)) throw new ProjectNotFoundError();
  return listIssueEventsAsync(db, id, { ...options, hydrateArtifacts: false });
}

export function startIssueFromPatch(
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

export function actionAndKickLoop(
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

export async function retryIssueAndKickLoop(
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

export function requestHumanReviewWithActor(
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

export function readIssue(context: ReadApiContext, id: number): PublicIssue {
  const issue = getIssue(context.database, id);
  if (!issue) throw new ProjectNotFoundError();
  const dependency = readProjectIssueDependencies(context.database, issue.project_id).get(issue.id);
  if (!dependency) throw new ProjectNotFoundError();
  return publicIssue(context.database, issue, getProject(context.database, issue.project_id), dependency);
}

export function publicIssues(context: ReadApiContext, issues: Issue[]): PublicIssue[] {
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

export function publicIssue(
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

export function publicIssueRuns(runs: IssueRun[]): PublicIssueRunView[] {
  return runs.map(publicIssueRun);
}

export function publicIssueRun(run: IssueRun): PublicIssueRunView {
  const { runtime_metadata_json, ...publicRun } = run;
  const metadata = parseRuntimeMetadata(runtime_metadata_json);
  return {
    ...publicRun,
    runtime_metadata: metadata,
    service_tier: cleanString(metadata.service_tier),
    service_tier_source: cleanString(metadata.service_tier_source)
  };
}

export function projectsByID(projects: Project[]): Map<string, Project> {
  return new Map(projects.map((project) => [project.id, project]));
}

export function actionOptions(body: Record<string, unknown>): IssueActionOptions {
  return Object.hasOwn(body, "service_tier")
    ? { serviceTier: cleanString(body.service_tier), serviceTierProvided: true }
    : {};
}

export function isStartIssuePatch(body: Record<string, unknown>): boolean {
  return typeof body.status === "string" && body.status.trim() === "in_progress";
}

export function hasOpenIssueRun(db: RunnerDatabase, issueID: number): boolean {
  return listIssueRuns(db, issueID).some((run) => run.ended_at === "");
}

export function parseRuntimeMetadata(value: string): PublicIssueRunMetadata {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as PublicIssueRunMetadata : {};
  } catch {
    return {};
  }
}

export function terminalForSkillAudit(status: string): boolean {
  return ["cancelled", "done", "failed"].includes(status);
}

export function safeAuditSkillIntents(db: RunnerDatabase, issueID: number): void {
  try { auditIssueSkillIntents(db, issueID); } catch {}
}
