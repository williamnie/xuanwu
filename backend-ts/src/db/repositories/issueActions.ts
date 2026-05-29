import type { RunnerDatabase } from "../database.ts";
import { issueTimestamp } from "./issueCreate.ts";
import { getIssue, type Issue } from "./issues.ts";
import { getProject, ProjectNotFoundError } from "./projects.ts";

const STATUS_TODO = "todo";
const STATUS_CANCELLED = "cancelled";

export function enqueueIssue(db: RunnerDatabase, id: number): Issue {
  const issue = mustGetRunnableIssue(db, id);
  return queueIssue(db, issue);
}

export function retryIssue(db: RunnerDatabase, id: number): Issue {
  const issue = mustGetRunnableIssue(db, id);
  return queueIssue(db, issue);
}

export function cancelIssue(db: RunnerDatabase, id: number, reason = "issue_cancel"): Issue {
  const issue = mustGetIssue(db, id);
  const timestamp = issueTimestamp();
  const write = db.transaction((record: Issue) => {
    db.sqlite.run(`update issues set status=?, error='', auto_retry_next_at='',
      auto_retry_reason='', updated_at=? where id=?`, [STATUS_CANCELLED, timestamp, record.id]);
    closeOpenIssueRun(db, { ...record, status: STATUS_CANCELLED }, STATUS_CANCELLED, reason, timestamp);
    recordStatusEvent(db, record.id, { status: STATUS_CANCELLED, reason }, timestamp);
  });
  write(issue);
  return mustGetIssue(db, issue.id);
}

function queueIssue(db: RunnerDatabase, issue: Issue): Issue {
  const timestamp = issueTimestamp();
  const write = db.transaction((record: Issue) => {
    db.sqlite.run(`update issues set status=?, error='', codex_turn_id='',
      auto_retry_next_at='', auto_retry_reason='', updated_at=? where id=?`,
      [STATUS_TODO, timestamp, record.id]);
    closeOpenIssueRun(db, queuedIssue(record), STATUS_TODO, "status_changed", timestamp);
    recordStatusEvent(db, record.id, { status: STATUS_TODO }, timestamp);
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
