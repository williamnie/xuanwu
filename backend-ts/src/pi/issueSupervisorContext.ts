import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { getIssue, listIssueRuns, type Issue } from "../db/repositories/issues.ts";
import { listIssueSupervisorEvents, readProjectPiPolicy } from "../db/repositories/pi.ts";
import { getProject, type Project } from "../db/repositories/projects.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { applyRecoveryBudgetToHistory, readPiRecoveryBudget } from "./recoveryBudget.ts";
import type { ProviderErrorSignal } from "./providerErrorParser.ts";
import {
  candidates,
  issueContext,
  latestProviderError,
  policyContext,
  projectContext,
  recoveryHistory,
  resolveSession,
  runContext,
  sessionContext,
  summarizeIssueEvent,
  workspaceSnapshot,
  type RecentSupervisorEvent,
  type SupervisorCandidate
} from "./issueSupervisorContextSupport.ts";
import { providerDeferredCount, providerDeferredWindowStart } from "./providerOutageDiagnosis.ts";
import { listIssueEventsAsync } from "../db/asyncIssueEvents.ts";
import type { IssueEvent } from "../db/repositories/issueEvents.ts";

export type IssueSupervisorContextOptions = {
  now?: Date;
  recentEventLimit?: number;
  staleAfterSeconds?: number;
};

export type IssueSupervisorRecoveryContext = {
  candidates: SupervisorCandidate[];
  issue: Record<string, unknown>;
  latest_run: Record<string, unknown> | null;
  policy: Record<string, unknown>;
  project: Record<string, unknown>;
  provider_error: ProviderErrorSignal | null;
  recent_events: RecentSupervisorEvent[];
  recovery_history: Record<string, unknown>;
  session: Record<string, unknown>;
  workspace_snapshot: Record<string, unknown>;
};

const DEFAULT_RECENT_EVENT_LIMIT = 25;
const MAX_SUPERVISOR_EVENT_LIMIT = 500;
const DEFAULT_STALE_SECONDS = 15 * 60;

export function buildIssueSupervisorRecoveryContext(
  db: RunnerDatabase,
  issueID: number,
  options: IssueSupervisorContextOptions = {}
): IssueSupervisorRecoveryContext {
  const events = listIssueEvents(db, issueID, supervisorEventOptions());
  return buildIssueSupervisorRecoveryContextFromEvents(db, issueID, events, options);
}

export async function buildIssueSupervisorRecoveryContextAsync(
  db: RunnerDatabase,
  issueID: number,
  options: IssueSupervisorContextOptions = {}
): Promise<IssueSupervisorRecoveryContext> {
  const events = await listIssueEventsAsync(db.path, issueID, supervisorEventOptions());
  return buildIssueSupervisorRecoveryContextFromEvents(db, issueID, events, options);
}

function buildIssueSupervisorRecoveryContextFromEvents(
  db: RunnerDatabase,
  issueID: number,
  events: IssueEvent[],
  options: IssueSupervisorContextOptions
): IssueSupervisorRecoveryContext {
  const now = options.now ?? new Date();
  const issue = mustIssue(db, issueID);
  const project = mustProject(db, issue.project_id);
  const runs = listIssueRuns(db, issue.id);
  const latestRun = runs.at(-1) ?? null;
  const session = resolveSession(db, issue, latestRun);
  const currentRunEvents = eventsForLatestRun(events, latestRun?.started_at ?? "");
  const recentEvents = events.slice(-recentLimit(options)).map(summarizeIssueEvent);
  const providerError = latestProviderError(currentRunEvents, now);
  const policy = readProjectPiPolicy(db, issue.project_id);
  const supervisorEvents = listIssueSupervisorEvents(db, { issueId: issue.id });
  const projectSupervisorEvents = listIssueSupervisorEvents(db, { projectId: issue.project_id });
  const budget = readPiRecoveryBudget(db, {
    actionType: "session.resume_followup",
    issueID: issue.id,
    now,
    projectID: issue.project_id,
    projectLimit: policy.supervisor_max_recoveries_per_project_per_hour,
    sessionID: session?.session_key
  });
  const history = applyRecoveryBudgetToHistory(
    recoveryHistory(supervisorEvents, policy.supervisor_max_recoveries_per_issue, now),
    budget
  );
  return {
    candidates: candidates({
      events: currentRunEvents,
      history,
      issueStatus: issue.status,
      latestRun,
      now,
      policy,
      projectDeferredCount: providerDeferredCount(db, {
        projectID: issue.project_id,
        provider: latestRun?.provider || project.provider,
        since: providerDeferredWindowStart(now)
      }),
      providerError,
      session,
      staleAfterSeconds: options.staleAfterSeconds ?? DEFAULT_STALE_SECONDS
    }),
    issue: issueContext(issue),
    latest_run: latestRun ? runContext(latestRun) : null,
    policy: policyContext({ policy, history, projectEvents: projectSupervisorEvents, now }),
    project: projectContext(project),
    provider_error: providerError,
    recent_events: recentEvents,
    recovery_history: history,
    session: sessionContext({ session, latestRun, now, staleAfterSeconds: options.staleAfterSeconds ?? DEFAULT_STALE_SECONDS }),
    workspace_snapshot: workspaceSnapshot(project.cwd, recentEvents)
  };
}

function supervisorEventOptions() {
  return {
    hydrateArtifacts: false,
    limit: MAX_SUPERVISOR_EVENT_LIMIT
  } as const;
}

function eventsForLatestRun<T extends { created_at: string }>(events: T[], startedAt: string): T[] {
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) return events;
  return events.filter((event) => {
    const eventMs = Date.parse(event.created_at);
    return Number.isFinite(eventMs) && eventMs >= startedMs;
  });
}

function recentLimit(options: IssueSupervisorContextOptions): number {
  return options.recentEventLimit && options.recentEventLimit > 0 ? options.recentEventLimit : DEFAULT_RECENT_EVENT_LIMIT;
}

function mustIssue(db: RunnerDatabase, issueID: number): Issue {
  const issue = getIssue(db, issueID);
  if (!issue) throw new Error(`issue ${issueID} not found`);
  return issue;
}

function mustProject(db: RunnerDatabase, projectID: string): Project {
  const project = getProject(db, projectID);
  if (!project) throw new Error(`project ${projectID} not found`);
  return project;
}
