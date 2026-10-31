import { evaluateQueueCandidate, providerAvailability } from "./queueEligibility.ts";
import { issueTimestamp } from "../db/repositories/issueCreate.ts";
import { getProject } from "../db/repositories/projects.ts";
import { getIssue, listIssueRuns, type Issue } from "../db/repositories/issues.ts";
import type { Project } from "../db/repositories/projects.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { resolveExecutorSelection, type AgentRecommendation } from "../pi/runtime/agentOrchestration.ts";
import { isExecutorProviderId, type ExecutorProvider } from "../providers/types.ts";
import type { ProjectLoopInput, ProjectLoopDecision } from "./projectLoop.model.ts";

export function selectedProvider(
  project: Project,
  selection: AgentRecommendation,
  providers: ProjectLoopInput["providers"]
): ExecutorProvider {
  if (isExecutorProviderId(selection.provider)) {
    const preferred = providers[selection.provider];
    if (preferred) {
      assertProviderReady(preferred, project.id);
      return preferred;
    }
    throw new Error(`project ${project.id} provider "${selection.provider}" is not registered`);
  }
  return projectProvider(project, providers);
}

export function issueProviderAvailable(
  db: RunnerDatabase,
  project: Project,
  issue: Issue,
  providers: ProjectLoopInput["providers"],
  now: Date | string | undefined
): boolean {
  const providerID = issueProviderID(db, project, issue);
  const provider = isExecutorProviderId(providerID) ? providers[providerID] : undefined;
  void now;
  return evaluateQueueCandidate({ provider: providerAvailability(providerID, provider) }).length === 0;
}

export function assertProviderReady(provider: ExecutorProvider, projectID: string): void {
  const status = provider.runtimeStatus?.();
  if (status?.ready !== false) return;
  throw new Error(`project ${projectID} provider "${provider.id}" is not ready: ${status.reason || "configuration required"}`);
}

export function issueProviderID(db: RunnerDatabase, project: Project, issue: Issue): string {
  const selection = resolveExecutorSelection(db, project, issue);
  return isExecutorProviderId(selection.provider) ? selection.provider : project.provider.trim();
}

export function decision(
  allowed: boolean,
  authority: string,
  issue: Issue | null,
  provider: string,
  reason: ProjectLoopDecision["reason"],
  scope: string
): ProjectLoopDecision {
  return { allowed, authority, issue, provider, reason, scope };
}

export function recordProjectLoopDecision(db: RunnerDatabase, input: ProjectLoopDecision): void {
  if (!input.issue) return;
  const payload = JSON.stringify({
    authority: input.authority,
    decision: input.allowed ? "continue" : "stop",
    provider: input.provider,
    reason: input.reason,
    scope: input.scope
  });
  const previous = db.sqlite.query<{ payload: string }, [number]>(`
    select payload from issue_events where issue_id=? and type='issue.runner_scope_decision'
    order by id desc limit 1
  `).get(input.issue.id)?.payload;
  if (!input.allowed && previous === payload) return;
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, 'issue.runner_scope_decision', ?, ?)`,
    [input.issue.id, payload, issueTimestamp()]
  );
}

export function issueExecutionNoLongerCurrent(db: RunnerDatabase, issueID: number, runID: string): boolean {
  const issue = getIssue(db, issueID);
  if (!issue || CLOSED_ISSUE_STATUSES.has(issue.status)) return true;
  const run = listIssueRuns(db, issueID).find((item) => item.id === runID);
  return !run || run.ended_at !== "";
}

export const CLOSED_ISSUE_STATUSES = new Set(["done", "failed", "cancelled", "needs_user"]);

export function mustGetProject(db: RunnerDatabase, projectId: string): Project {
  const project = getProject(db, projectId);
  if (!project) throw new Error(`project ${projectId} not found`);
  return project;
}

export function projectProvider(project: Project, providers: ProjectLoopInput["providers"]): ExecutorProvider {
  const providerID = project.provider.trim();
  if (!isExecutorProviderId(providerID)) throw new Error(`project ${project.id} provider "${providerID}" is not supported`);
  const provider = providers[providerID];
  if (!provider) throw new Error(`project ${project.id} provider "${providerID}" is not registered`);
  assertProviderReady(provider, project.id);
  return provider;
}
