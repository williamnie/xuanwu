import type { RunnerDatabase } from "../../db/database.ts";
import { hydrateStoredIssueLogPayload } from "../../db/repositories/issueEvents.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import { ProjectErrorSnapshot, PROJECT_STATUS_LIMIT, IssueErrorRow, RunRow, mapRunRow, EventRow, type ProjectStatusSnapshot, ABSOLUTE_PATH_PATTERN } from "./projectSnapshot.ts";

export function recentProjectErrors(
  db: RunnerDatabase,
  projectID: string
): ProjectErrorSnapshot[] {
  const errors = [
    ...issueErrors(db, projectID),
    ...runErrors(db, projectID),
    ...eventErrors(db, projectID)
  ];
  return errors
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp) || sourceOrder(left) - sourceOrder(right))
    .slice(0, PROJECT_STATUS_LIMIT);
}

export function issueErrors(db: RunnerDatabase, projectID: string): ProjectErrorSnapshot[] {
  return db.sqlite.query<IssueErrorRow, [string, number]>(`
    select id, status, title, error, updated_at from issues
    where project_id=? and (status='failed' or error<>'')
    order by updated_at desc, id desc limit ?
  `).all(projectID, PROJECT_STATUS_LIMIT).map((issue) => ({
    issue_id: integerValue(issue.id),
    message: redactSnapshotText(optionalString(issue.error) || "issue failed"),
    source: "issue" as const,
    status: optionalString(issue.status, "unknown"),
    timestamp: optionalString(issue.updated_at)
  }));
}

export function runErrors(db: RunnerDatabase, projectID: string): ProjectErrorSnapshot[] {
  return db.sqlite.query<RunRow, [string, number]>(`
    select ir.id as run_id, ir.issue_id, ir.attempt, ir.status, ir.provider, ir.started_at,
      ir.ended_at, ir.exit_reason, ir.error
    from issue_runs ir join issues i on i.id=ir.issue_id
    where i.project_id=? and (ir.status='failed' or ir.error<>'')
    order by coalesce(nullif(ir.ended_at, ''), ir.started_at) desc, ir.attempt desc limit ?
  `).all(projectID, PROJECT_STATUS_LIMIT).map(mapRunRow).map((run) => ({
    issue_id: run.issue_id,
    message: redactSnapshotText(run.error || "run failed"),
    source: "run" as const,
    status: run.status,
    timestamp: run.ended_at || run.started_at
  }));
}

export function eventErrors(db: RunnerDatabase, projectID: string): ProjectErrorSnapshot[] {
  return db.sqlite.query<EventRow, [string]>(`
    select e.issue_id, e.type, e.payload, e.created_at from issue_events e
    join issues i on i.id=e.issue_id
    where i.project_id=? and e.type in ('issue.log', 'issue.error', 'runner.hold')
    order by e.created_at desc, e.id desc limit ${PROJECT_STATUS_LIMIT}
  `).all(projectID).map((row) => mapEventError(db, row))
    .filter((item): item is ProjectErrorSnapshot => item !== null);
}

export function sourceOrder(error: ProjectErrorSnapshot): number {
  if (error.source === "event") return 0;
  if (error.source === "run") return 1;
  return 2;
}

export function mapEventError(db: RunnerDatabase, row: EventRow): ProjectErrorSnapshot | null {
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

export function eventErrorMessage(payload: string): string {
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

export function compactSummary(snapshot: Omit<ProjectStatusSnapshot, "compact_summary">): string {
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

export function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort(([left], [right]) => left.localeCompare(right));
  return entries.length === 0 ? "=0" : ` [${entries.map(([key, value]) => `${key}=${value}`).join(", ")}]`;
}

export function tableExists(db: RunnerDatabase, table: string): boolean {
  const row = db.sqlite.query<{ name: string }, [string]>(
    "select name from sqlite_master where type='table' and name=?"
  ).get(table);
  return row?.name === table;
}

export function summarizePath(value: string): string {
  const clean = value.trim();
  if (clean === "") return "";
  const parts = clean.split(/[\\/]+/).filter(Boolean);
  return parts.length === 0 ? "[redacted-path]" : `[redacted-path]/${redactSnapshotText(parts.at(-1) ?? "")}`;
}

export function redactSnapshotText(value: string): string {
  return redactSensitiveText(value).replace(ABSOLUTE_PATH_PATTERN, "[redacted-path]");
}

export function optionalString(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed === "" ? fallback : trimmed;
}

export function integerValue(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}
