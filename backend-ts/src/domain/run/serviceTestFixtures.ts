import { afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createIssueRun, updateIssueRuntime } from "../../db/repositories/issueRuns.ts";

import type { RunTransitionAudit } from "./contracts.ts";

import { readRunRevision, type NewRunCommand, type RunAttemptCommand, type RunInterruptCommand } from "./service.ts";
import { useDatabaseCleanup } from "../../testing/harness.ts";

export const trackDatabase = useDatabaseCleanup();

export const NOW = "2026-07-16T06:00:00.000Z";

export const LATER = "2026-07-16T06:01:00.000Z";

export const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

export type Fixture = { db: RunnerDatabase; stateDir: string };

export type ActiveRun = { issue_id: number; issue_run_id: string; run_id: `xw:run:${string}:${string}` };

export async function openFixture(slug: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `xuanwu-${slug}-`));
  tempRoots.push(root);
  const stateDir = join(root, "state");
  const db = await openDatabase({ stateDir }).then(trackDatabase);
  db.sqlite.run(`insert into projects (id, name, cwd, provider, created_at, updated_at)
    values ('demo', 'demo', ?, 'codex', ?, ?)`, [join(root, "repo"), NOW, NOW]);
  return { db, stateDir };
}

export function activeRun(db: RunnerDatabase, sessionID: string, turnID: string): ActiveRun {
  const inserted = db.sqlite.run(`insert into issues (
    project_id, title, description, status, created_at, updated_at
  ) values ('demo', 'Run lifecycle fixture', '', 'in_progress', ?, ?)`, [NOW, NOW]);
  const issueID = Number(inserted.lastInsertRowid);
  const run = createIssueRun(db, issueID);
  updateIssueRuntime(db, issueID, {
    issue_run_id: run.id,
    provider: "codex",
    provider_session_id: sessionID,
    provider_turn_id: turnID
  });
  return {
    issue_id: issueID,
    issue_run_id: run.id,
    run_id: canonicalRunID(db, run.id)
  };
}

export function attemptCommand(
  db: RunnerDatabase,
  run: ActiveRun,
  kind: "recovery" | "resume",
  eventID: string,
  terminal: "interrupted" | "succeeded"
): RunAttemptCommand {
  const latest = attempts(db, run.issue_run_id).at(-1);
  if (!latest) throw new Error("latest Attempt missing");
  return {
    audit: audit(eventID, `${kind} provider session`),
    expected_attempt_revision: latest.revision,
    expected_revision: readRunRevision(db, run.issue_id, run.run_id),
    issue_run_id: run.issue_run_id,
    kind,
    previous_attempt_terminal: {
      reason: kind === "recovery" ? "runner restarted" : "previous turn completed",
      source_ref: `issue_events:${eventID}:precondition`,
      status: terminal
    },
    provider_ref: { provider: "codex", session_ref: latest.provider_session_id },
    run_id: run.run_id
  };
}

export function interruptCommand(db: RunnerDatabase, run: ActiveRun, eventID: string): RunInterruptCommand {
  const latest = attempts(db, run.issue_run_id).at(-1);
  if (!latest) throw new Error("latest Attempt missing");
  return {
    attempt_id: latest.attempt_id,
    audit: audit(eventID, "interrupt provider turn"),
    expected_attempt_revision: latest.revision,
    expected_revision: readRunRevision(db, run.issue_id, run.run_id),
    issue_run_id: run.issue_run_id,
    provider_ref: {
      invocation_ref: latest.provider_invocation_ref,
      provider: latest.provider,
      session_ref: latest.provider_session_id,
      turn_ref: latest.provider_turn_id
    },
    run_id: run.run_id
  };
}

export function newRunCommand(
  db: RunnerDatabase,
  run: ActiveRun,
  operation: NewRunCommand["operation"],
  eventID: string
): NewRunCommand {
  return {
    audit: audit(eventID, `${operation} Run`),
    expected_revision: readRunRevision(db, run.issue_id, run.run_id),
    issue_run_id: run.issue_run_id,
    operation,
    run_id: run.run_id
  };
}

export function audit(eventID: string, reason: string): RunTransitionAudit {
  return {
    actor: { id: "runner", kind: "runner" },
    correlation_id: `correlation:${eventID}`,
    event_id: eventID,
    gate: { authority: "deterministic_policy", decision: "allow", policy_ref: "run-lifecycle:p03.04" },
    occurred_at: LATER,
    reason
  };
}

export function canonicalRunID(db: RunnerDatabase, issueRunID: string): ActiveRun["run_id"] {
  const row = db.sqlite.query<{ run_id: string }, [string]>("select run_id from issue_runs where id=?").get(issueRunID);
  if (!row?.run_id.startsWith("xw:run:")) throw new Error("canonical Run ID missing");
  return row.run_id as ActiveRun["run_id"];
}

export function terminalRun(db: RunnerDatabase, issueRunID: string, status: "failed"): void {
  const row = runState(db, issueRunID);
  db.sqlite.run(`update issue_runs set status=?, ended_at=?, exit_reason=?, error=? where id=?`, [
    status,
    LATER,
    "provider_failed",
    "fixture failure",
    issueRunID
  ]);
  db.sqlite.run("update issues set status=?, error=?, updated_at=? where id=?", [
    status,
    "fixture failure",
    LATER,
    row.issue_id
  ]);
}

export function attempts(db: RunnerDatabase, issueRunID: string): Array<Record<string, any>> {
  return db.sqlite.query<Record<string, any>, [string]>(`
    select attempt_id, sequence, kind, status, revision, provider,
      provider_invocation_ref, provider_session_id, provider_turn_id,
      cost_json, ended_at, terminal_reason, terminal_source_ref
    from run_attempts where issue_run_id=? order by sequence
  `).all(issueRunID);
}

export function measuredCost(input: number, output: number, cached: number, reasoning: number) {
  return {
    money: { amount_micros: null, basis: "unavailable", currency: "" },
    pricing_refs: [],
    source_refs: ["provider-event:usage-baseline"],
    usage: {
      cached_input_tokens: cached,
      completeness: "complete",
      input_tokens: input,
      output_tokens: output,
      reasoning_output_tokens: reasoning,
      total_tokens: input + output
    }
  };
}

export function lifecyclePayload(db: RunnerDatabase, eventID: string, type: string): Record<string, any> {
  const row = db.sqlite.query<{ payload: string }, [string, string]>(`
    select payload from issue_events where type=? and json_extract(payload, '$.event_id')=? limit 1
  `).get(type, eventID);
  return JSON.parse(row?.payload ?? "{}");
}

export function eventCount(db: RunnerDatabase, eventID: string, type: string): number {
  return db.sqlite.query<{ count: number }, [string, string]>(`
    select count(*) as count from issue_events
    where type=? and json_valid(payload) and json_extract(payload, '$.event_id')=?
  `).get(type, eventID)?.count ?? 0;
}

export function issueState(db: RunnerDatabase, issueID: number): Record<string, unknown> {
  return db.sqlite.query<Record<string, unknown>, [number]>(
    "select id, status, codex_thread_id, codex_turn_id from issues where id=?"
  ).get(issueID) ?? {};
}

export function runState(db: RunnerDatabase, issueRunID: string): Record<string, any> {
  return db.sqlite.query<Record<string, any>, [string]>(
    "select id, issue_id, attempt, status, ended_at, exit_reason from issue_runs where id=?"
  ).get(issueRunID) ?? {};
}
