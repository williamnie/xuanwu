import type { RunnerDatabase } from "../db/database.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { getIssue, listIssueRuns, listIssues, type Issue, type IssueRun } from "../db/repositories/issues.ts";
import { redactSensitiveText } from "../util/redact.ts";

export const DEFAULT_ISSUE_LIST_LIMIT = 50;
export const MAX_ISSUE_LIST_LIMIT = 50;

type IssueScope = { projectId?: string; status?: string };
type IssueListInput = IssueScope & { limit?: number };
type IssueStatusInput = IssueScope;
type IssueSummary = {
  comment_count: number;
  id: number;
  priority: number;
  project_id: string;
  service_tier: string;
  status: string;
  title: string;
  updated_at: string;
};

const TERMINAL_STATUSES = new Set(["done", "cancelled"]);
const RECENT_EVENT_LIMIT = 5;
const PREVIEW_CHARS = 320;
const ABSOLUTE_PATH_PATTERN = /(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g;

export function createCompactIssueList(db: RunnerDatabase, input: IssueListInput) {
  const issues = listIssues(db, { projectId: input.projectId, status: input.status });
  const limit = issueListLimit(input.limit);
  return {
    detail_hint: "Use issue_read for full issue body; use issue_execution_status for run/log status.",
    included_fields: ["id", "project_id", "title", "status", "priority", "service_tier", "comment_count", "updated_at"],
    items: issues.slice(0, limit).map(issueSummary),
    limit,
    source: "issue_list",
    status_counts: countStatuses(issues),
    total: issues.length,
    truncated: issues.length > limit
  };
}

export function createIssueStatusSummary(db: RunnerDatabase, input: IssueStatusInput) {
  const scoped = listIssues(db, { projectId: input.projectId });
  const status = cleanString(input.status);
  const matching = status === "" ? scoped : scoped.filter((issue) => issue.status === status);
  return {
    matching_total: matching.length,
    project_id: cleanString(input.projectId),
    source: "issue_status_summary",
    status_counts: countStatuses(scoped),
    status_filter: status,
    total: scoped.length,
    unfinished_status_counts: countStatuses(scoped.filter(isUnfinishedIssue)),
    unfinished_total: scoped.filter(isUnfinishedIssue).length
  };
}

export function createIssueExecutionStatus(db: RunnerDatabase, issueID: number) {
  const issue = getIssue(db, issueID);
  if (!issue) throw new Error("issue not found");
  const runs = listIssueRuns(db, issue.id);
  const latestRun = runs.at(-1);
  return {
    detail_hint: "Use issue_read only when full description is needed.",
    issue: issueSummary(issue),
    latest_run: latestRun ? runSummary(latestRun) : null,
    recent_events: recentIssueEvents(db, issue.id),
    run_count: runs.length,
    source: "issue_execution_status"
  };
}

function issueSummary(issue: Issue): IssueSummary {
  return {
    comment_count: issue.comment_count,
    id: issue.id,
    priority: issue.priority,
    project_id: issue.project_id,
    service_tier: issue.service_tier,
    status: issue.status,
    title: safeText(issue.title),
    updated_at: issue.updated_at
  };
}

function runSummary(run: IssueRun) {
  return {
    attempt: run.attempt,
    ended_at: run.ended_at,
    error: preview(run.error),
    exit_reason: safeText(run.exit_reason),
    provider: run.provider,
    provider_session_id: safeText(run.provider_session_id),
    started_at: run.started_at,
    status: run.status
  };
}

function recentIssueEvents(db: RunnerDatabase, issueID: number) {
  return listIssueEvents(db, issueID, {
    hydrateArtifacts: false,
    limit: RECENT_EVENT_LIMIT
  }).reverse().map((event) => ({
    created_at: event.created_at,
    id: event.id,
    payload_preview: preview(event.payload),
    type: event.type
  }));
}

function countStatuses(items: Array<{ status: string }>): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const status = item.status || "unknown";
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
}

function isUnfinishedIssue(issue: Issue): boolean {
  return !TERMINAL_STATUSES.has(issue.status);
}

function issueListLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return DEFAULT_ISSUE_LIST_LIMIT;
  return Math.min(Math.max(value, 1), MAX_ISSUE_LIST_LIMIT);
}

function preview(value: string): string {
  const text = safeText(value);
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

function safeText(value: string): string {
  return redactSensitiveText(value).replace(ABSOLUTE_PATH_PATTERN, "[redacted-path]");
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
