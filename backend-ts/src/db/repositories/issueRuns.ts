import type { RunnerDatabase } from "../database.ts";
import { issueTimestamp } from "./issueCreate.ts";
import { listIssueRuns, type IssueRun } from "./issues.ts";

export type IssueRunRuntimeInput = {
  agent_profile_id?: string;
  capability_summary?: string;
  issue_run_id?: string;
  metadata?: unknown;
  provider?: string;
  provider_session_id?: string;
  provider_turn_id?: string;
  selection_reason?: string;
};

type RuntimeTarget = { args: Array<number | string>; sql: string };

export function createIssueRun(db: RunnerDatabase, issueID: number): IssueRun {
  const attempt = nextAttempt(db, issueID);
  const id = `issue-${issueID}-attempt-${attempt}`;
  db.sqlite.run(`insert into issue_runs (id, issue_id, attempt, status, provider, started_at)
    values (?, ?, ?, ?, ?, ?)`, [id, issueID, attempt, "in_progress", "codex", issueTimestamp()]);
  return mustFindIssueRun(db, issueID, id);
}

export function ensureOpenIssueRun(db: RunnerDatabase, issueID: number): IssueRun {
  const openRun = listIssueRuns(db, issueID).filter((run) => run.ended_at === "").at(-1);
  return openRun ?? createIssueRun(db, issueID);
}

export function updateIssueRuntime(db: RunnerDatabase, issueID: number, input: IssueRunRuntimeInput): void {
  updateOpenIssueRunRuntime(db, issueID, input);
  if ((cleanString(input.provider) || "codex") !== "codex") return;
  const sessionID = cleanString(input.provider_session_id);
  const turnID = cleanString(input.provider_turn_id);
  if (sessionID === "" && turnID === "") return;
  db.sqlite.run(`update issues set
    codex_thread_id=case when ?<>'' then ? else codex_thread_id end,
    codex_turn_id=case when ?<>'' then ? else codex_turn_id end,
    updated_at=? where id=?`, [sessionID, sessionID, turnID, turnID, issueTimestamp(), issueID]);
}

export function updateOpenIssueRunRuntime(db: RunnerDatabase, issueID: number, input: IssueRunRuntimeInput): void {
  updateTargetIssueRunRuntime(db, issueID, input);
}

function updateTargetIssueRunRuntime(db: RunnerDatabase, issueID: number, input: IssueRunRuntimeInput): void {
  const provider = cleanString(input.provider) || "codex";
  const sessionID = cleanString(input.provider_session_id);
  const turnID = cleanString(input.provider_turn_id);
  const metadata = JSON.stringify(input.metadata ?? {});
  const target = runtimeTarget(issueID, input);
  db.sqlite.run(`update issue_runs set provider=?,
    provider_session_id=case when ?<>'' then ? else provider_session_id end,
    provider_turn_id=case when ?<>'' then ? else provider_turn_id end,
    codex_thread_id=case when ?='codex' and ?<>'' then ? when ?<>'codex' then '' else codex_thread_id end,
    codex_turn_id=case when ?='codex' and ?<>'' then ? when ?<>'codex' then '' else codex_turn_id end,
    agent_profile_id=case when ?<>'' then ? else agent_profile_id end,
    capability_summary=case when ?<>'' then ? else capability_summary end,
    selection_reason=case when ?<>'' then ? else selection_reason end,
    runtime_metadata_json=case when ?<>'{}' then ? else runtime_metadata_json end
    where ${target.sql}`,
    [provider, sessionID, sessionID, turnID, turnID, provider, sessionID, sessionID,
      provider, provider, turnID, turnID, provider,
      cleanString(input.agent_profile_id), cleanString(input.agent_profile_id),
      cleanString(input.capability_summary), cleanString(input.capability_summary),
      cleanString(input.selection_reason), cleanString(input.selection_reason),
      metadata, metadata, ...target.args]);
}

function runtimeTarget(issueID: number, input: IssueRunRuntimeInput): RuntimeTarget {
  const id = cleanString(input.issue_run_id);
  if (id !== "") return { args: [id, issueID], sql: "id=? and issue_id=?" };
  const provider = cleanString(input.provider);
  const sessionID = cleanString(input.provider_session_id);
  if (provider !== "" && provider !== "codex" && sessionID !== "") {
    return {
      args: [issueID, issueID, provider, sessionID],
      sql: `id=coalesce(
        (select id from issue_runs where issue_id=? and ended_at='' order by attempt desc limit 1),
        (select id from issue_runs where issue_id=? and provider=? and provider_session_id=?
          order by attempt desc limit 1)
      )`
    };
  }
  return {
    args: [issueID],
    sql: "id=(select id from issue_runs where issue_id=? and ended_at='' order by attempt desc limit 1)"
  };
}

function nextAttempt(db: RunnerDatabase, issueID: number): number {
  const row = db.sqlite.query<{ attempt: number }, [number]>(
    "select coalesce(max(attempt), 0) + 1 as attempt from issue_runs where issue_id=?"
  ).get(issueID);
  return row?.attempt ?? 1;
}

function mustFindIssueRun(db: RunnerDatabase, issueID: number, id: string): IssueRun {
  const run = listIssueRuns(db, issueID).find((item) => item.id === id);
  if (!run) throw new Error("issue run missing after write");
  return run;
}

function cleanString(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
