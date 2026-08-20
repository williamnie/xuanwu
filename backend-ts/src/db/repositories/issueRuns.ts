import type { RunnerDatabase } from "../database.ts";
import { pendingRunCreation, recordRunMaterialized } from "../../domain/run/service.ts";
import {
  recordCapturedIssueRunGitWorkspaceBaseline,
  type CapturedGitWorkspaceBaseline
} from "../../domain/evidence/runGitWorkspaceBaseline.ts";
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

export type ReservedIssueRun = {
  attempt: number;
  issue_id: number;
  project_cwd: string;
  project_id: string;
  run_id: string;
  started_at: string;
};
export type RunPreparationResult =
  | { baseline_recorded: boolean; status: "ready"; run: IssueRun }
  | { status: "claim_invalidated"; run: IssueRun | null };

export function createIssueRun(db: RunnerDatabase, issueID: number): IssueRun {
  const reservation = insertIssueRunRecord(db, issueID);
  return mustFindIssueRun(db, issueID, reservation.run_id);
}

export function insertIssueRunRecord(
  db: RunnerDatabase,
  issueID: number,
  input: { provider?: string; startedAt?: string } = {}
): ReservedIssueRun {
  const attempt = nextAttempt(db, issueID);
  const requested = pendingRunCreation(db, issueID, attempt);
  const id = `issue-${issueID}-attempt-${attempt}`;
  const project = issueProject(db, issueID);
  const startedAt = input.startedAt ?? issueTimestamp();
  db.sqlite.run(`insert into issue_runs (
    id, issue_id, attempt, status, provider, git_base_revision, started_at
  ) values (?, ?, ?, ?, ?, ?, ?)`, [
    id, issueID, attempt, "in_progress", cleanString(input.provider) || "codex", "", startedAt
  ]);
  if (requested) recordRunMaterialized(db, requested, id);
  return {
    attempt,
    issue_id: issueID,
    project_cwd: project.cwd,
    project_id: project.id,
    run_id: id,
    started_at: startedAt
  };
}

export function finalizeIssueRunPreparation(
  db: RunnerDatabase,
  reservation: ReservedIssueRun,
  baseline: CapturedGitWorkspaceBaseline | null
): RunPreparationResult {
  const finalize = db.transaction((): RunPreparationResult => {
    const current = currentReservedRun(db, reservation);
    if (!current) return { status: "claim_invalidated", run: null };
    if (!baseline) return { baseline_recorded: false, status: "ready", run: current };
    const update = db.sqlite.run(`update issue_runs set git_base_revision=?
      where id=? and issue_id=? and attempt=? and ended_at='' and git_base_revision=''
        and exists (
          select 1 from issues i join projects p on p.id=i.project_id
          where i.id=? and i.status='in_progress' and p.id=? and trim(p.cwd)=?
            and issue_runs.id=(select id from issue_runs current
              where current.issue_id=i.id and current.ended_at='' order by current.attempt desc limit 1)
        )`, [
      baseline.base_revision, reservation.run_id, reservation.issue_id, reservation.attempt,
      reservation.issue_id, reservation.project_id, reservation.project_cwd
    ]);
    if (update.changes !== 1) return { status: "claim_invalidated", run: null };
    recordCapturedIssueRunGitWorkspaceBaseline(db, reservation.issue_id, reservation.run_id, baseline);
    return {
      baseline_recorded: true,
      status: "ready",
      run: mustFindIssueRun(db, reservation.issue_id, reservation.run_id)
    };
  });
  return finalize.immediate();
}

export function mustGetCurrentOpenIssueRun(db: RunnerDatabase, issueID: number, runID: string): IssueRun {
  const id = cleanString(runID);
  if (!id) throw new Error("issueRunId is required");
  const row = db.sqlite.query<{ id: string }, [number, string]>(`
    select ir.id from issue_runs ir join issues i on i.id=ir.issue_id
    where ir.issue_id=? and ir.id=? and ir.ended_at='' and i.status='in_progress'
      and ir.id=(select id from issue_runs where issue_id=i.id and ended_at='' order by attempt desc limit 1)
  `).get(issueID, id);
  if (!row) throw new Error("issueRunId is not the canonical current open Run");
  return mustFindIssueRun(db, issueID, id);
}

function currentReservedRun(db: RunnerDatabase, reservation: ReservedIssueRun): IssueRun | null {
  const row = db.sqlite.query<{ id: string }, [string, number, number, string, string]>(`
    select ir.id from issue_runs ir
    join issues i on i.id=ir.issue_id
    join projects p on p.id=i.project_id
    where ir.id=? and ir.issue_id=? and ir.attempt=? and ir.ended_at=''
      and i.status='in_progress' and p.id=? and trim(p.cwd)=?
      and ir.id=(select id from issue_runs where issue_id=i.id and ended_at='' order by attempt desc limit 1)
  `).get(
    reservation.run_id,
    reservation.issue_id,
    reservation.attempt,
    reservation.project_id,
    reservation.project_cwd
  );
  return row ? mustFindIssueRun(db, reservation.issue_id, reservation.run_id) : null;
}

function issueProject(db: RunnerDatabase, issueID: number): { cwd: string; id: string } {
  const project = db.sqlite.query<{ cwd: string; id: string }, [number]>(`
    select projects.cwd, projects.id from issues
    join projects on projects.id=issues.project_id
    where issues.id=?
  `).get(issueID);
  if (!project) throw new Error("issue project missing during Run reservation");
  return { cwd: project.cwd.trim(), id: project.id.trim() };
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
  if (!isCurrentOpenRun(db, issueID, cleanString(input.issue_run_id))) return;
  db.sqlite.run(`update issues set
    codex_thread_id=case when ?<>'' then ? else codex_thread_id end,
    codex_turn_id=case when ?<>'' then ? else codex_turn_id end,
    updated_at=? where id=?`, [sessionID, sessionID, turnID, turnID, issueTimestamp(), issueID]);
}

function isCurrentOpenRun(db: RunnerDatabase, issueID: number, targetRunID: string): boolean {
  const row = db.sqlite.query<{ id: string }, [number]>(
    "select id from issue_runs where issue_id=? and ended_at='' order by attempt desc limit 1"
  ).get(issueID);
  if (!row) return false;
  return targetRunID === "" || row.id === targetRunID;
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
