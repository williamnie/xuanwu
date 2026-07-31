import type { RunnerDatabase } from "../database.ts";
import {
  pendingNewRunRequest,
  readRunRevision,
  requestNewRun,
  type NewRunCommand
} from "../../domain/run/service.ts";
import { issueTimestamp } from "./issueCreate.ts";
import { getIssue, listIssueRuns, type Issue, type IssueRun } from "./issues.ts";
import { syncPiRunGroupsForIssueStatus } from "./pi/runGroups.ts";
import { getProject, ProjectNotFoundError } from "./projects.ts";

const STATUS_TODO = "todo";
const STATUS_IN_PROGRESS = "in_progress";
const STATUS_CANCELLED = "cancelled";

export type IssueActionOptions = { serviceTier?: string; serviceTierProvided?: boolean };

export function enqueueIssue(db: RunnerDatabase, id: number, options: IssueActionOptions = {}): Issue {
  const issue = mustGetRunnableIssue(db, id);
  if (isIssueActivelyRunning(db, issue)) return issue;
  return queueIssue(db, issue, options);
}

export function retryIssue(db: RunnerDatabase, id: number, options: IssueActionOptions = {}): Issue {
  const issue = mustGetRunnableIssue(db, id);
  if (isIssueActivelyRunning(db, issue)) return issue;
  return requestIssueRun(db, issue, options, "retry");
}

export function forceRetryIssue(db: RunnerDatabase, id: number, options: IssueActionOptions = {}): Issue {
  const issue = mustGetRunnableIssue(db, id);
  return requestIssueRun(db, issue, options, isIssueActivelyRunning(db, issue) ? "supersede" : "retry");
}

export function requeueUnstartedIssueClaim(db: RunnerDatabase, id: number): Issue {
  const issue = mustGetRunnableIssue(db, id);
  if (!hasUnstartedOpenRun(db, issue.id)) return issue;
  return queueIssue(db, issue, {}, true);
}

export function cancelIssue(db: RunnerDatabase, id: number, reason = "issue_cancel"): Issue {
  const issue = mustGetIssue(db, id);
  const timestamp = issueTimestamp();
  const write = db.transaction((record: Issue) => {
    const interruptedAttemptID = latestInterruptedAttemptID(db, record.id);
    db.sqlite.run(`update issues set status=?, error='', auto_retry_next_at='',
      auto_retry_reason='', updated_at=? where id=?`, [STATUS_CANCELLED, timestamp, record.id]);
    closeOpenIssueRun(db, { ...record, status: STATUS_CANCELLED }, STATUS_CANCELLED, reason, timestamp);
    restoreInterruptedAttempt(db, interruptedAttemptID, reason, timestamp);
    recordStatusEvent(db, record.id, { status: STATUS_CANCELLED, reason }, timestamp);
    syncPiRunGroupsForIssueStatus(db, {
      completedAt: timestamp,
      issueID: record.id,
      reason,
      status: STATUS_CANCELLED
    });
  });
  write(issue);
  return mustGetIssue(db, issue.id);
}

function latestInterruptedAttemptID(db: RunnerDatabase, issueID: number): string {
  return db.sqlite.query<{ attempt_id: string }, [number]>(`
    select attempt.attempt_id from run_attempts attempt
    join issue_runs run on run.id=attempt.issue_run_id
    where run.issue_id=? and run.ended_at='' and attempt.status='interrupted'
    order by run.attempt desc, attempt.sequence desc limit 1
  `).get(issueID)?.attempt_id ?? "";
}

function restoreInterruptedAttempt(
  db: RunnerDatabase,
  attemptID: string,
  reason: string,
  timestamp: string
): void {
  if (attemptID === "") return;
  db.sqlite.run(`update run_attempts set status='interrupted', ended_at=?,
    terminal_reason=?, terminal_source_ref=?, updated_at=? where attempt_id=?`, [
    timestamp,
    "provider turn interrupted before Run cancellation",
    `issue-action:${reason}`,
    timestamp,
    attemptID
  ]);
}

export function deleteIssue(db: RunnerDatabase, id: number): void {
  deleteIssues(db, [id]);
}

export function deleteIssues(db: RunnerDatabase, ids: number[]): { deleted_issue_ids: number[] } {
  const uniqueIDs = [...new Set(ids)];
  if (uniqueIDs.length === 0 || uniqueIDs.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("issue_ids must contain positive integers");
  }
  return db.transaction((issueIDs: number[]) => {
    const issues = issueIDs.map((issueID) => mustGetIssue(db, issueID));
    for (const issue of issues) {
      if (issue.status === "in_progress" || hasOpenIssueRun(db, issue.id)) {
        throw new Error("运行中的 issue 不能删除，请先取消执行");
      }
    }
    for (const issue of issues) {
      db.sqlite.run("delete from works where id=?", [`xw:work:issues:${issue.id}`]);
      const result = db.sqlite.run("delete from issues where id=?", [issue.id]);
      if (result.changes === 0) throw new ProjectNotFoundError();
    }
    return { deleted_issue_ids: issues.map((issue) => issue.id) };
  }).immediate(uniqueIDs);
}

function hasOpenIssueRun(db: RunnerDatabase, issueID: number): boolean {
  const row = db.sqlite.query<{ count: number }, [number]>(
    "select count(*) as count from issue_runs where issue_id=? and ended_at=''"
  ).get(issueID);
  return (row?.count ?? 0) > 0;
}

function hasUnstartedOpenRun(db: RunnerDatabase, issueID: number): boolean {
  const row = db.sqlite.query<{ count: number }, [number]>(
    `select count(*) as count from issue_runs
     where issue_id=? and ended_at='' and provider_session_id='' and provider_turn_id=''`
  ).get(issueID);
  return (row?.count ?? 0) > 0;
}

function isIssueActivelyRunning(db: RunnerDatabase, issue: Issue): boolean {
  return issue.status === STATUS_IN_PROGRESS && hasOpenIssueRun(db, issue.id);
}

function requestIssueRun(
  db: RunnerDatabase,
  issue: Issue,
  options: IssueActionOptions,
  operation: NewRunCommand["operation"]
): Issue {
  if (pendingNewRunRequest(db, issue.id)) return mustGetIssue(db, issue.id);
  const target = listIssueRuns(db, issue.id).at(-1);
  if (!target) return queueIssue(db, issue, options);
  const runID = canonicalRunID(target);
  const revision = readRunRevision(db, runID);
  const result = requestNewRun(db, {
    audit: {
      actor: { id: "issue-actions", kind: "runner" },
      correlation_id: `issue:${issue.id}:run:${target.id}:${operation}:${revision}`,
      event_id: lifecycleRequestID(issue, target, operation, revision, options),
      gate: {
        authority: "deterministic_policy",
        decision: "allow",
        policy_ref: "run-lifecycle:p03.04:issue-action"
      },
      occurred_at: issueTimestamp(),
      reason: `${operation} issue Run`
    },
    expected_revision: revision,
    issue_run_id: target.id,
    operation,
    run_id: runID,
    service_tier: options.serviceTier,
    service_tier_provided: options.serviceTierProvided
  });
  if (!result.applied) throw new Error(result.violations.join("; "));
  return mustGetIssue(db, issue.id);
}

function canonicalRunID(run: IssueRun): `xw:run:issue_runs:${string}` {
  return `xw:run:issue_runs:${run.id}`;
}

function lifecycleRequestID(
  issue: Issue,
  run: IssueRun,
  operation: NewRunCommand["operation"],
  revision: number,
  options: IssueActionOptions
): string {
  const tier = options.serviceTierProvided === true ? cleanString(options.serviceTier) : "unchanged";
  return `run-request:${operation}:${issue.id}:${run.id}:${revision}:${tier}`;
}

function queueIssue(
  db: RunnerDatabase,
  issue: Issue,
  options: IssueActionOptions,
  clearCompatibilitySession = false
): Issue {
  const timestamp = issueTimestamp();
  const serviceTier = cleanString(options.serviceTier);
  const hasServiceTier = options.serviceTierProvided === true;
  const write = db.transaction((record: Issue) => {
    db.sqlite.run(`update issues set status=?, error='',
      codex_thread_id=case when ?=1 then '' else codex_thread_id end, codex_turn_id='',
      service_tier=case when ?=1 then ? else service_tier end,
      auto_retry_next_at='', auto_retry_reason='', updated_at=? where id=?`,
      [STATUS_TODO, clearCompatibilitySession ? 1 : 0,
        hasServiceTier ? 1 : 0, serviceTier, timestamp, record.id]);
    const queued = queuedIssue(record);
    closeOpenIssueRun(db, clearCompatibilitySession ? {
      ...queued,
      codex_thread_id: ""
    } : queued, STATUS_TODO, "status_changed", timestamp);
    recordStatusEvent(db, record.id, statusEventPayload(STATUS_TODO, hasServiceTier, serviceTier), timestamp);
  });
  write(issue);
  return mustGetIssue(db, issue.id);
}

function queuedIssue(issue: Issue): Issue {
  return { ...issue, status: STATUS_TODO, codex_turn_id: "" };
}

function closeOpenIssueRun(
  db: RunnerDatabase,
  issue: Issue,
  status: string,
  exitReason: string,
  timestamp: string
): void {
  db.sqlite.run(`update issue_runs set status=?,
    provider_session_id=case when provider_session_id='' then ? else provider_session_id end,
    provider_turn_id=case when provider_turn_id='' then ? else provider_turn_id end,
    codex_thread_id=?, codex_turn_id=?, ended_at=?, exit_reason=?, error=''
    where id=(select id from issue_runs where issue_id=? and ended_at='' order by attempt desc limit 1)`,
    [status, issue.codex_thread_id, issue.codex_turn_id, issue.codex_thread_id,
      issue.codex_turn_id, timestamp, exitReason, issue.id]);
}

function recordStatusEvent(
  db: RunnerDatabase,
  issueID: number,
  payload: Record<string, string>,
  timestamp: string
): void {
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [issueID, "issue.status_changed", JSON.stringify(payload), timestamp]
  );
}

function statusEventPayload(status: string, hasServiceTier: boolean, serviceTier: string): Record<string, string> {
  return hasServiceTier ? { status, service_tier: serviceTier } : { status };
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function mustGetRunnableIssue(db: RunnerDatabase, id: number): Issue {
  const issue = mustGetIssue(db, id);
  const project = getProject(db, issue.project_id);
  if (!project) throw new ProjectNotFoundError();
  if (!project.provider_capabilities.includes("issue_execution")) {
    throw new Error(`project ${project.id} provider "${project.provider}" 暂不支持`);
  }
  return issue;
}

function mustGetIssue(db: RunnerDatabase, id: number): Issue {
  const issue = getIssue(db, id);
  if (!issue) throw new ProjectNotFoundError();
  return issue;
}
