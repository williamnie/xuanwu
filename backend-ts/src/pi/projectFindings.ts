import type { RunnerDatabase } from "../db/database.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { defaultFindingCategory, defaultFindingReason, evaluateProjectFailedRetryPolicy, type FailedRetryDecision } from "./failedRetryPolicy.ts";
import { matchFailurePattern } from "./failurePatterns.ts";

export type ProjectFindingCategory = "blocked" | "needs_user" | "transient" | "verification_needed";

export type ProjectFindingNotification = {
  message: string;
  type: "pi.issue_ready_for_acceptance" | "pi.needs_user" | "pi.project_blocked";
};

export type ProjectFinding = {
  category: ProjectFindingCategory;
  issue_id: number;
  message: string;
  notification?: ProjectFindingNotification;
  project_id: string;
  reason: string;
  severity: "blocked" | "needs_review";
  status: string;
  title: string;
  updated_at: string;
};

export type ProjectFindingScanOptions = { now?: Date; staleAfterMs?: number };

type IssueFindingRow = { attempt_count: unknown; auto_retry_next_at: unknown; auto_retry_reason: unknown;
  codex_thread_id: unknown; error: unknown; id: unknown; project_id: unknown; status: unknown; title: unknown; updated_at: unknown };
type StaleIssueRow = IssueFindingRow & {
  run_activity_at: unknown; session_activity_at: unknown; session_key: unknown; session_status: unknown;
};
type HoldFindingRow = { hold_since: unknown; last_check_error: unknown; message: unknown;
  project_id: unknown; reason: unknown; updated_at: unknown };
type IssueFindingContext = { now: Date };

const ABSOLUTE_PATH_PATTERN = /(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g;
const PROJECT_HOLD_ISSUE_ID = 0;
const DEFAULT_STALE_AFTER_MS = 2 * 60 * 60 * 1000;
const ACTIVE_SESSION_STATUSES = new Set(["active", "inprogress", "running"]);

export function scanProjectFindings(
  db: RunnerDatabase,
  projectID: string,
  options: ProjectFindingScanOptions = {}
): ProjectFinding[] {
  const id = projectID.trim();
  if (id === "") throw new Error("project id is required");
  return [...issueFindings(db, id, options), ...staleFindings(db, id, options), ...holdFindings(db, id)];
}

function issueFindings(db: RunnerDatabase, projectID: string, options: ProjectFindingScanOptions): ProjectFinding[] {
  const context = { now: options.now ?? new Date() };
  return db.sqlite.query<IssueFindingRow, [string]>(`
    select id, project_id, title, status, error, attempt_count, codex_thread_id, auto_retry_next_at,
      auto_retry_reason, updated_at from issues
    where project_id=? and (
      status in ('failed', 'pending_verification')
      or (status='todo' and auto_retry_next_at <> '')
    )
    order by case status when 'failed' then 0 else 1 end, updated_at asc, id asc
  `).all(projectID).map((row) => mapIssueFinding(db, projectID, row, context));
}

function holdFindings(db: RunnerDatabase, projectID: string): ProjectFinding[] {
  if (!tableExists(db, "project_holds")) return [];
  return db.sqlite.query<HoldFindingRow, [string]>(`
    select project_id, reason, message, hold_since, last_check_error, updated_at
    from project_holds where project_id=? order by hold_since asc, updated_at asc
  `).all(projectID).map(mapHoldFinding);
}

function mapIssueFinding(
  db: RunnerDatabase,
  projectID: string,
  row: IssueFindingRow,
  context: IssueFindingContext
): ProjectFinding {
  const status = optionalString(row.status, "unknown");
  const issueID = integerValue(row.id);
  const rawDetail = optionalString(row.error) || optionalString(row.title);
  const detail = redactFindingText(rawDetail);
  const pattern = matchFailurePattern(db, projectID, rawDetail);
  const policy = retryDecision(db, projectID, row, pattern?.category ?? issueFindingCategory(row), context);
  const category = policy?.category ?? pattern?.category ?? issueFindingCategory(row);
  const message = issueMessage(status, issueID, detail, pattern?.recommendation);
  const reason = pattern ? "failure_pattern" : policy?.reason ?? defaultFindingReason(status, category);
  return {
    category,
    issue_id: issueID,
    message,
    notification: issueNotification(category, message),
    project_id: optionalString(row.project_id),
    reason,
    severity: category === "verification_needed" || category === "transient" ? "needs_review" : "blocked",
    status,
    title: redactFindingText(optionalString(row.title)),
    updated_at: optionalString(row.updated_at)
  };
}

function staleFindings(
  db: RunnerDatabase,
  projectID: string,
  options: ProjectFindingScanOptions
): ProjectFinding[] {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS));
  return db.sqlite.query<StaleIssueRow, [string]>(`
    select i.id, i.project_id, i.title, i.status, i.error, i.codex_thread_id,
      i.auto_retry_next_at, i.auto_retry_reason, i.updated_at,
      (select max(coalesce(nullif(ended_at, ''), started_at)) from issue_runs where issue_id=i.id) as run_activity_at,
      (select max(updated_at) from agent_sessions where issue_id=i.id or (
        i.codex_thread_id <> '' and provider='codex' and provider_session_id=i.codex_thread_id
      )) as session_activity_at,
      (select session_key from agent_sessions where issue_id=i.id or (
        i.codex_thread_id <> '' and provider='codex' and provider_session_id=i.codex_thread_id
      ) order by updated_at desc limit 1) as session_key,
      (select status from agent_sessions where issue_id=i.id or (
        i.codex_thread_id <> '' and provider='codex' and provider_session_id=i.codex_thread_id
      ) order by updated_at desc limit 1) as session_status
    from issues i where i.project_id=? and i.status='in_progress'
    order by i.updated_at asc, i.id asc
  `).all(projectID).filter((row) => isStale(row, cutoff)).map((row) => mapStaleFinding(row, now));
}

function mapStaleFinding(row: StaleIssueRow, now: Date): ProjectFinding {
  const issueID = integerValue(row.id);
  const activity = latestActivity(row);
  const inactivity = formatDuration(now.getTime() - parseTimestamp(activity));
  const message = `Issue #${issueID} appears stale: inactive for ${inactivity} without run/session activity`;
  return {
    category: "needs_user",
    issue_id: issueID,
    message,
    notification: { type: "pi.needs_user", message },
    project_id: optionalString(row.project_id),
    reason: "stale_issue",
    severity: "blocked",
    status: optionalString(row.status, "in_progress"),
    title: redactFindingText(optionalString(row.title)),
    updated_at: optionalString(row.updated_at)
  };
}

function mapHoldFinding(row: HoldFindingRow): ProjectFinding {
  const reason = redactFindingText(optionalString(row.reason, "project_hold"));
  const detail = holdDetail(row);
  const message = `Project is on hold${detail ? `: ${detail}` : ""}`;
  return {
    category: "blocked",
    issue_id: PROJECT_HOLD_ISSUE_ID,
    message,
    notification: { type: "pi.project_blocked", message },
    project_id: optionalString(row.project_id),
    reason: `project_hold:${reason}`,
    severity: "blocked",
    status: "hold",
    title: "Project hold",
    updated_at: optionalString(row.updated_at) || optionalString(row.hold_since)
  };
}

function holdDetail(row: HoldFindingRow): string {
  return [optionalString(row.message), optionalString(row.last_check_error)]
    .map(redactFindingText)
    .filter(Boolean)
    .join("; ");
}

function issueLead(status: string, issueID: number): string {
  if (status === "failed") return `Issue #${issueID} failed`;
  if (status === "todo") return `Issue #${issueID} is waiting for transient retry`;
  return `Issue #${issueID} is pending verification`;
}

function issueMessage(status: string, issueID: number, detail: string, recommendation: string | undefined): string {
  const base = `${issueLead(status, issueID)}${detail ? `: ${detail}` : ""}`;
  if (!recommendation) return base;
  return `${base}; known failure pattern: ${redactFindingText(recommendation)}`;
}

function issueFindingCategory(row: IssueFindingRow): ProjectFindingCategory {
  return defaultFindingCategory({
    autoRetryNextAt: optionalString(row.auto_retry_next_at),
    detail: optionalString(row.error) || optionalString(row.title),
    status: optionalString(row.status)
  });
}

function retryDecision(
  db: RunnerDatabase,
  projectID: string,
  row: IssueFindingRow,
  category: ProjectFindingCategory,
  context: IssueFindingContext
): FailedRetryDecision | undefined {
  return evaluateProjectFailedRetryPolicy({
    attemptCount: attemptCount(row),
    autoRetryNextAt: optionalString(row.auto_retry_next_at),
    category,
    db,
    now: context.now,
    projectID,
    status: optionalString(row.status),
    updatedAt: optionalString(row.updated_at)
  });
}

function attemptCount(row: IssueFindingRow): number {
  return typeof row.attempt_count === "number" && Number.isInteger(row.attempt_count) ? row.attempt_count : 0;
}

function issueNotification(
  category: ProjectFindingCategory,
  message: string
): ProjectFindingNotification | undefined {
  if (category === "verification_needed") return { type: "pi.issue_ready_for_acceptance", message };
  if (category === "needs_user") return { type: "pi.needs_user", message };
  if (category === "blocked") return { type: "pi.project_blocked", message };
  return undefined;
}

function isStale(row: StaleIssueRow, cutoff: Date): boolean {
  if (isActiveSessionStatus(optionalString(row.session_status))) return false;
  const activity = latestActivity(row);
  return activity !== "" && parseTimestamp(activity) <= cutoff.getTime();
}

function latestActivity(row: StaleIssueRow): string {
  return [row.updated_at, row.run_activity_at, row.session_activity_at]
    .map((value) => optionalString(value))
    .sort()
    .at(-1) ?? "";
}

function isActiveSessionStatus(value: string): boolean {
  return ACTIVE_SESSION_STATUSES.has(value.toLowerCase().replace(/[_\s-]/g, ""));
}

function parseTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
}

function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return minutes < 120 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}
function tableExists(db: RunnerDatabase, table: string): boolean {
  const row = db.sqlite.query<{ name: string }, [string]>(
    "select name from sqlite_master where type='table' and name=?"
  ).get(table);
  return row?.name === table;
}

function redactFindingText(value: string): string {
  return redactSensitiveText(value).replace(ABSOLUTE_PATH_PATTERN, "[redacted-path]");
}

function optionalString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function integerValue(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}
