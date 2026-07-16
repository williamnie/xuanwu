import type { RunnerDatabase } from "../db/database.ts";
import { listAgentSessions, type AgentSession } from "../db/repositories/agentSessions.ts";
import { hydrateStoredIssueLogPayload } from "../db/repositories/issueEvents.ts";
import { listIssues, type Issue } from "../db/repositories/issues.ts";
import { getProject, type Project } from "../db/repositories/projects.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { scanProjectFindings, type ProjectFinding } from "./projectFindings.ts";
import { listProjectSessionProgress, type SessionProgressSummary } from "./sessionObserver.ts";

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

type ProjectRunSnapshot = {
  attempt: number; ended_at: string; exit_reason: string; issue_id: number;
  provider: string; run_id: string; started_at: string; status: string;
};

type ProjectSessionSnapshot = {
  agent_role: string; issue_id: number; provider: string; provider_session_id: string;
  session_key: string; status: string; title: string; updated_at: string;
};

type ProjectHoldSnapshot = {
  hold_since: string; last_check_at: string; last_check_error: string; message: string;
  next_check_at: string; reason: string; updated_at: string;
};

type ProjectErrorSnapshot = {
  issue_id: number; message: string; source: "event" | "issue" | "run"; status: string; timestamp: string;
};

type RunRow = {
  attempt: unknown; ended_at: unknown; error: unknown; exit_reason: unknown; issue_id: unknown;
  provider: unknown; run_id: unknown; started_at: unknown; status: unknown;
};

type HoldRow = Record<keyof ProjectHoldSnapshot, unknown>;
type EventRow = { created_at: unknown; issue_id: unknown; payload: unknown; type: unknown };

const PROJECT_STATUS_LIMIT = 8;
const ABSOLUTE_PATH_PATTERN = /(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g;

export function createProjectStatusSnapshot(db: RunnerDatabase, projectID: string): ProjectStatusSnapshot {
  const project = requireProject(db, projectID);
  const issues = listIssues(db, { projectId: project.id });
  const runs = listProjectRuns(db, project.id);
  const sessions = listAgentSessions(db, { projectId: project.id });
  const sessionProgress = listProjectSessionProgress(db, project.id);
  const holds = listProjectHolds(db, project.id);
  const findings = scanProjectFindings(db, project.id);
  const recentErrors = recentProjectErrors(db, project.id, issues, runs);
  const snapshot = {
    active_holds: holds,
    cwd: summarizePath(project.cwd),
    findings,
    id: project.id,
    issue_status_counts: countStatuses(issues),
    latest_issues: latestIssues(issues),
    name: redactSnapshotText(project.name),
    provider: project.provider,
    recent_errors: recentErrors,
    recent_runs: recentRuns(runs),
    recent_sessions: recentSessions(sessions),
    run_status_counts: countStatuses(runs),
    session_progress: sessionProgress,
    session_status_counts: countStatuses(sessions),
    total_issues: issues.length
  };
  return {
    ...snapshot,
    compact_summary: compactSummary(snapshot)
  };
}

function requireProject(db: RunnerDatabase, id: string): Project {
  const project = getProject(db, id);
  if (!project) throw new Error("project not found");
  return project;
}

function countStatuses(items: Array<{ status: string }>): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const status = item.status || "unknown";
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
}

function latestIssues(issues: Issue[]): ProjectStatusSnapshot["latest_issues"] {
  return [...issues]
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || right.id - left.id)
    .slice(0, PROJECT_STATUS_LIMIT)
    .map((issue) => ({
      id: issue.id,
      status: issue.status,
      title: redactSnapshotText(issue.title),
      updated_at: issue.updated_at
    }));
}

function listProjectRuns(db: RunnerDatabase, projectID: string): Array<ProjectRunSnapshot & { error: string }> {
  return db.sqlite.query<RunRow, [string]>(`
    select ir.id as run_id, ir.issue_id, ir.attempt, ir.status, ir.provider, ir.started_at,
      ir.ended_at, ir.exit_reason, ir.error
    from issue_runs ir join issues i on i.id=ir.issue_id
    where i.project_id=?
    order by coalesce(nullif(ir.ended_at, ''), ir.started_at) desc, ir.attempt desc
  `).all(projectID).map(mapRunRow);
}

function mapRunRow(row: RunRow): ProjectRunSnapshot & { error: string } {
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

function recentRuns(runs: Array<ProjectRunSnapshot & { error: string }>): ProjectRunSnapshot[] {
  return runs.slice(0, PROJECT_STATUS_LIMIT).map(({ error: _error, ...run }) => run);
}

function recentSessions(sessions: AgentSession[]): ProjectSessionSnapshot[] {
  return sessions.slice(0, PROJECT_STATUS_LIMIT).map((session) => ({
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

function listProjectHolds(db: RunnerDatabase, projectID: string): ProjectHoldSnapshot[] {
  if (!tableExists(db, "project_holds")) return [];
  return db.sqlite.query<HoldRow, [string]>(`
    select reason, message, hold_since, next_check_at, last_check_at, last_check_error, updated_at
    from project_holds where project_id=? order by hold_since asc
  `).all(projectID).map(mapHoldRow);
}

function mapHoldRow(row: HoldRow): ProjectHoldSnapshot {
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

function recentProjectErrors(
  db: RunnerDatabase,
  projectID: string,
  issues: Issue[],
  runs: Array<ProjectRunSnapshot & { error: string }>
): ProjectErrorSnapshot[] {
  const errors = [
    ...issueErrors(issues),
    ...runErrors(runs),
    ...eventErrors(db, projectID)
  ];
  return errors
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp) || sourceOrder(left) - sourceOrder(right))
    .slice(0, PROJECT_STATUS_LIMIT);
}

function issueErrors(issues: Issue[]): ProjectErrorSnapshot[] {
  return issues
    .filter((issue) => issue.status === "failed" || issue.error !== "")
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || right.id - left.id)
    .map((issue) => ({
      issue_id: issue.id,
      message: redactSnapshotText(issue.error || "issue failed"),
      source: "issue" as const,
      status: issue.status,
      timestamp: issue.updated_at
    }));
}

function runErrors(runs: Array<ProjectRunSnapshot & { error: string }>): ProjectErrorSnapshot[] {
  return runs.filter((run) => run.status === "failed" || run.error !== "").map((run) => ({
    issue_id: run.issue_id,
    message: redactSnapshotText(run.error || "run failed"),
    source: "run" as const,
    status: run.status,
    timestamp: run.ended_at || run.started_at
  }));
}

function eventErrors(db: RunnerDatabase, projectID: string): ProjectErrorSnapshot[] {
  return db.sqlite.query<EventRow, [string]>(`
    select e.issue_id, e.type, e.payload, e.created_at from issue_events e
    join issues i on i.id=e.issue_id
    where i.project_id=? and e.type in ('issue.log', 'issue.error', 'runner.hold')
    order by e.created_at desc, e.id desc limit ${PROJECT_STATUS_LIMIT}
  `).all(projectID).map((row) => mapEventError(db, row))
    .filter((item): item is ProjectErrorSnapshot => item !== null);
}

function sourceOrder(error: ProjectErrorSnapshot): number {
  if (error.source === "event") return 0;
  if (error.source === "run") return 1;
  return 2;
}

function mapEventError(db: RunnerDatabase, row: EventRow): ProjectErrorSnapshot | null {
  const storedPayload = optionalString(row.payload);
  const payload = optionalString(row.type) === "issue.log"
    ? hydrateStoredIssueLogPayload(db, storedPayload)
    : storedPayload;
  const message = eventErrorMessage(payload);
  if (message === "") return null;
  return {
    issue_id: integerValue(row.issue_id),
    message: redactSnapshotText(message),
    source: "event",
    status: optionalString(row.type),
    timestamp: optionalString(row.created_at)
  };
}

function eventErrorMessage(payload: string): string {
  if (payload === "") return "";
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const type = optionalString(parsed.type);
    const text = optionalString(parsed.error) || optionalString(parsed.message) || optionalString(parsed.text);
    return type.includes("error") || text !== "" ? text : "";
  } catch {
    return /error|failed|panic|fatal/i.test(payload) ? payload : "";
  }
}

function compactSummary(snapshot: Omit<ProjectStatusSnapshot, "compact_summary">): string {
  const issueCounts = formatCounts(snapshot.issue_status_counts);
  const runCounts = formatCounts(snapshot.run_status_counts);
  const sessionCounts = formatCounts(snapshot.session_status_counts);
  return [
    `project ${snapshot.id}: ${snapshot.name}`,
    `issues total=${snapshot.total_issues}${issueCounts}`,
    `runs${runCounts}`,
    `sessions${sessionCounts}`,
    `holds=${snapshot.active_holds.length}`,
    `findings=${snapshot.findings.length}`,
    `recent_errors=${snapshot.recent_errors.length}`
  ].join("; ");
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort(([left], [right]) => left.localeCompare(right));
  return entries.length === 0 ? "=0" : ` [${entries.map(([key, value]) => `${key}=${value}`).join(", ")}]`;
}

function tableExists(db: RunnerDatabase, table: string): boolean {
  const row = db.sqlite.query<{ name: string }, [string]>(
    "select name from sqlite_master where type='table' and name=?"
  ).get(table);
  return row?.name === table;
}

function summarizePath(value: string): string {
  const clean = value.trim();
  if (clean === "") return "";
  const parts = clean.split(/[\\/]+/).filter(Boolean);
  return parts.length === 0 ? "[redacted-path]" : `[redacted-path]/${redactSnapshotText(parts.at(-1) ?? "")}`;
}

function redactSnapshotText(value: string): string {
  return redactSensitiveText(value).replace(ABSOLUTE_PATH_PATTERN, "[redacted-path]");
}

function optionalString(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed === "" ? fallback : trimmed;
}

function integerValue(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}
