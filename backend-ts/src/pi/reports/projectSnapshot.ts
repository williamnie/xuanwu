import type { RunnerDatabase } from "../../db/database.ts";
import { listAgentSessions, type AgentSession } from "../../db/repositories/agentSessions.ts";
import { getProject, type Project } from "../../db/repositories/projects.ts";
import { scanProjectFindings, type ProjectFinding } from "./projectFindings.ts";
import { listProjectSessionProgress, type SessionProgressSummary } from "../runnerTools/sessionObserver.ts";
import { recentProjectErrors, summarizePath, redactSnapshotText, compactSummary, optionalString, integerValue, tableExists } from "./projectSnapshotErrors.ts";

export type ProjectStatusSnapshot = {
  active_holds: ProjectHoldSnapshot[];
  compact_summary: string;
  cwd: string;
  findings: ProjectFinding[];
  id: string;
  issue_status_counts: Record<string, number>;
  latest_issues: Array<{ id: number; status: string; title: string; updated_at: string }>;
  name: string;
  provider: string;
  recent_errors: ProjectErrorSnapshot[];
  recent_runs: ProjectRunSnapshot[];
  recent_sessions: ProjectSessionSnapshot[];
  run_status_counts: Record<string, number>;
  session_progress: SessionProgressSummary[];
  session_status_counts: Record<string, number>;
  total_issues: number;
};

export type ProjectRunSnapshot = {
  attempt: number; ended_at: string; exit_reason: string; issue_id: number;
  provider: string; run_id: string; started_at: string; status: string;
};

export type ProjectSessionSnapshot = {
  agent_role: string; issue_id: number; provider: string; provider_session_id: string;
  session_key: string; status: string; title: string; updated_at: string;
};

export type ProjectHoldSnapshot = {
  hold_since: string; last_check_at: string; last_check_error: string; message: string;
  next_check_at: string; reason: string; updated_at: string;
};

export type ProjectErrorSnapshot = {
  issue_id: number; message: string; source: "event" | "issue" | "run"; status: string; timestamp: string;
};

export type RunRow = {
  attempt: unknown; ended_at: unknown; error: unknown; exit_reason: unknown; issue_id: unknown;
  provider: unknown; run_id: unknown; started_at: unknown; status: unknown;
};

export type HoldRow = Record<keyof ProjectHoldSnapshot, unknown>;

export type EventRow = { created_at: unknown; issue_id: unknown; payload: unknown; type: unknown };

export type StatusCountRow = { count: unknown; status: unknown };

export type IssueSummaryRow = { id: unknown; status: unknown; title: unknown; updated_at: unknown };

export type IssueErrorRow = IssueSummaryRow & { error: unknown };

export const PROJECT_STATUS_LIMIT = 8;

export const ABSOLUTE_PATH_PATTERN = /(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g;

export function createProjectStatusSnapshot(db: RunnerDatabase, projectID: string): ProjectStatusSnapshot {
  const project = requireProject(db, projectID);
  const issueStatusCounts = projectStatusCounts(db, "issues", project.id);
  const runStatusCounts = projectRunStatusCounts(db, project.id);
  const sessionStatusCounts = projectStatusCounts(db, "agent_sessions", project.id);
  const runs = listProjectRuns(db, project.id, PROJECT_STATUS_LIMIT);
  const sessions = listAgentSessions(db, { limit: PROJECT_STATUS_LIMIT, projectId: project.id });
  const sessionProgress = listProjectSessionProgress(db, project.id);
  const holds = listProjectHolds(db, project.id);
  const findings = scanProjectFindings(db, project.id, { limit: PROJECT_STATUS_LIMIT });
  const recentErrors = recentProjectErrors(db, project.id);
  const snapshot = {
    active_holds: holds,
    cwd: summarizePath(project.cwd),
    findings,
    id: project.id,
    issue_status_counts: issueStatusCounts,
    latest_issues: latestIssues(db, project.id),
    name: redactSnapshotText(project.name),
    provider: project.provider,
    recent_errors: recentErrors,
    recent_runs: runs.map(({ error: _error, ...run }) => run),
    recent_sessions: recentSessions(sessions),
    run_status_counts: runStatusCounts,
    session_progress: sessionProgress,
    session_status_counts: sessionStatusCounts,
    total_issues: Object.values(issueStatusCounts).reduce((total, count) => total + count, 0)
  };
  return {
    ...snapshot,
    compact_summary: compactSummary(snapshot)
  };
}

export function requireProject(db: RunnerDatabase, id: string): Project {
  const project = getProject(db, id);
  if (!project) throw new Error("project not found");
  return project;
}

export function projectStatusCounts(
  db: RunnerDatabase,
  table: "agent_sessions" | "issues",
  projectID: string
): Record<string, number> {
  return statusCounts(db.sqlite.query<StatusCountRow, [string]>(`
    select status, count(*) as count from ${table} where project_id=? group by status
  `).all(projectID));
}

export function projectRunStatusCounts(db: RunnerDatabase, projectID: string): Record<string, number> {
  return statusCounts(db.sqlite.query<StatusCountRow, [string]>(`
    select ir.status, count(*) as count from issue_runs ir
    join issues i on i.id=ir.issue_id where i.project_id=? group by ir.status
  `).all(projectID));
}

export function statusCounts(rows: StatusCountRow[]): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [optionalString(row.status, "unknown"), integerValue(row.count)]));
}

export function latestIssues(db: RunnerDatabase, projectID: string): ProjectStatusSnapshot["latest_issues"] {
  return db.sqlite.query<IssueSummaryRow, [string, number]>(`
    select id, status, title, updated_at from issues where project_id=?
    order by updated_at desc, id desc limit ?
  `).all(projectID, PROJECT_STATUS_LIMIT).map((issue) => ({
    id: integerValue(issue.id),
    status: optionalString(issue.status, "unknown"),
    title: redactSnapshotText(optionalString(issue.title)),
    updated_at: optionalString(issue.updated_at)
  }));
}

export function listProjectRuns(
  db: RunnerDatabase,
  projectID: string,
  limit: number
): Array<ProjectRunSnapshot & { error: string }> {
  return db.sqlite.query<RunRow, [string, number]>(`
    select ir.id as run_id, ir.issue_id, ir.attempt, ir.status, ir.provider, ir.started_at,
      ir.ended_at, ir.exit_reason, ir.error
    from issue_runs ir join issues i on i.id=ir.issue_id
    where i.project_id=?
    order by coalesce(nullif(ir.ended_at, ''), ir.started_at) desc, ir.attempt desc
    limit ?
  `).all(projectID, limit).map(mapRunRow);
}

export function mapRunRow(row: RunRow): ProjectRunSnapshot & { error: string } {
  return {
    attempt: integerValue(row.attempt),
    ended_at: optionalString(row.ended_at),
    error: redactSnapshotText(optionalString(row.error)),
    exit_reason: redactSnapshotText(optionalString(row.exit_reason)),
    issue_id: integerValue(row.issue_id),
    provider: optionalString(row.provider, "codex"),
    run_id: optionalString(row.run_id),
    started_at: optionalString(row.started_at),
    status: optionalString(row.status, "unknown")
  };
}

export function recentSessions(sessions: AgentSession[]): ProjectSessionSnapshot[] {
  return sessions.map((session) => ({
    agent_role: session.agent_role,
    issue_id: session.issue_id,
    provider: session.provider,
    provider_session_id: session.provider_session_id,
    session_key: session.session_key,
    status: session.status || "unknown",
    title: redactSnapshotText(session.title),
    updated_at: session.updated_at
  }));
}

export function listProjectHolds(db: RunnerDatabase, projectID: string): ProjectHoldSnapshot[] {
  if (!tableExists(db, "project_holds")) return [];
  return db.sqlite.query<HoldRow, [string]>(`
    select reason, message, hold_since, next_check_at, last_check_at, last_check_error, updated_at
    from project_holds where project_id=? order by hold_since asc
  `).all(projectID).map(mapHoldRow);
}

export function mapHoldRow(row: HoldRow): ProjectHoldSnapshot {
  return {
    hold_since: optionalString(row.hold_since),
    last_check_at: optionalString(row.last_check_at),
    last_check_error: redactSnapshotText(optionalString(row.last_check_error)),
    message: redactSnapshotText(optionalString(row.message)),
    next_check_at: optionalString(row.next_check_at),
    reason: redactSnapshotText(optionalString(row.reason)),
    updated_at: optionalString(row.updated_at)
  };
}
