import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createIssueRun, updateIssueRuntime } from "../../db/repositories/issueRuns.ts";
import { projectNormalizedRunEvent } from "../../db/repositories/runAttemptEvents.ts";
import { normalizedRunEvent, providerRunCost } from "../../providers/runEvents.ts";
import type { RunTransitionAudit } from "./contracts.ts";
import {
  RUN_LIFECYCLE_EVENT_TYPES,
  completeRunAttemptStart,
  completeRunInterrupt,
  pendingRunCreation,
  prepareRunAttempt,
  prepareRunInterrupt,
  readRunRevision,
  recordRunMaterialized,
  requestNewRun,
  type NewRunCommand,
  type RunAttemptCommand,
  type RunInterruptCommand
} from "./service.ts";

const NOW = "2026-07-16T06:00:00.000Z";
const LATER = "2026-07-16T06:01:00.000Z";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Run lifecycle command service", () => {
  test("prepares and starts one resume Attempt for repeated commands", async () => {
    const fixture = await openFixture("resume-idempotency");
    try {
      const run = activeRun(fixture.db, "thread-resume", "turn-1");
      const command = attemptCommand(fixture.db, run, "resume", "resume-1", "succeeded");

      const first = prepareRunAttempt(fixture.db, command);
      const duplicate = prepareRunAttempt(fixture.db, command);
      expect(first).toMatchObject({ completed: false, replayed: false, should_invoke: true });
      expect(duplicate).toMatchObject({ attempt_id: first.attempt_id, replayed: true, should_invoke: false });

      const provider = {
        invocation_ref: "codex:thread-resume:turn-2",
        provider_session_id: "thread-resume",
        provider_turn_id: "turn-2"
      };
      expect(completeRunAttemptStart(fixture.db, "resume-1", provider)).toMatchObject({ completed: true, replayed: false });
      expect(completeRunAttemptStart(fixture.db, "resume-1", provider)).toMatchObject({ completed: true, replayed: true });

      expect(attempts(fixture.db, run.issue_run_id)).toEqual([
        expect.objectContaining({ kind: "initial", sequence: 1, status: "succeeded" }),
        expect.objectContaining({
          attempt_id: first.attempt_id,
          kind: "resume",
          provider_invocation_ref: "codex:thread-resume:turn-2",
          provider_session_id: "thread-resume",
          provider_turn_id: "turn-2",
          sequence: 2,
          status: "running"
        })
      ]);
      expect(eventCount(fixture.db, "resume-1", RUN_LIFECYCLE_EVENT_TYPES.intent)).toBe(1);
      expect(eventCount(fixture.db, "resume-1", RUN_LIFECYCLE_EVENT_TYPES.outcome)).toBe(1);
      expect(readRunRevision(fixture.db, run.run_id)).toBe(2);
    } finally {
      fixture.db.close();
    }
  });

  test("fails closed on a prepared recovery after database restart and preserves provider turn refs", async () => {
    const fixture = await openFixture("recovery-restart");
    const run = activeRun(fixture.db, "thread-recovery", "turn-old");
    const command = attemptCommand(fixture.db, run, "recovery", "recovery-1", "interrupted");
    const prepared = prepareRunAttempt(fixture.db, command);
    fixture.db.close();

    const reopened = await openDatabase({ stateDir: fixture.stateDir });
    try {
      expect(prepareRunAttempt(reopened, command)).toEqual({
        ...prepared,
        completed: false,
        replayed: true,
        should_invoke: false
      });
      completeRunAttemptStart(reopened, "recovery-1", {
        invocation_ref: "codex:thread-recovery:turn-recovered",
        provider_session_id: "thread-recovery",
        provider_turn_id: "turn-recovered"
      });
      expect(attempts(reopened, run.issue_run_id)).toEqual([
        expect.objectContaining({ sequence: 1, status: "interrupted" }),
        expect.objectContaining({
          kind: "recovery",
          provider_session_id: "thread-recovery",
          provider_turn_id: "turn-recovered",
          sequence: 2,
          status: "running"
        })
      ]);
    } finally {
      reopened.close();
    }
  });

  test("projects Codex provider-session totals as an audited resume Attempt delta", async () => {
    const fixture = await openFixture("resume-usage-delta");
    try {
      const run = activeRun(fixture.db, "thread-usage", "turn-1");
      fixture.db.sqlite.run("update run_attempts set cost_json=?, revision=revision+1 where issue_run_id=?", [
        JSON.stringify(measuredCost(12, 5, 3, 2)),
        run.issue_run_id
      ]);
      const command = attemptCommand(fixture.db, run, "resume", "resume-usage-1", "succeeded");
      const prepared = prepareRunAttempt(fixture.db, command);
      completeRunAttemptStart(fixture.db, "resume-usage-1", {
        invocation_ref: "codex:thread-usage:turn-2",
        provider_session_id: "thread-usage",
        provider_turn_id: "turn-2"
      });
      const cost = providerRunCost({
        sourceRef: "provider-event:usage-total",
        usage: {
          cached_input_tokens: 5,
          input_tokens: 20,
          output_tokens: 8,
          reasoning_output_tokens: 3,
          total_tokens: 28
        }
      });
      if (!cost) throw new Error("fixture cost missing");
      projectNormalizedRunEvent(fixture.db, run.issue_run_id, normalizedRunEvent({
        cost,
        kind: "progress",
        metadata: { usage_scope: "provider_session_total" },
        method: "thread/tokenUsage/updated",
        outcome: "running",
        provider: "codex",
        session: { provider: "codex", sessionId: "thread-usage", turnId: "turn-2" }
      }), 900);

      const resumed = attempts(fixture.db, run.issue_run_id).find((attempt) => attempt.attempt_id === prepared.attempt_id);
      expect(JSON.parse(String(resumed?.cost_json ?? "{}"))).toMatchObject({
        usage: {
          cached_input_tokens: 2,
          completeness: "complete",
          input_tokens: 8,
          output_tokens: 3,
          reasoning_output_tokens: 1,
          total_tokens: 11
        }
      });
      const intent = lifecyclePayload(fixture.db, "resume-usage-1", RUN_LIFECYCLE_EVENT_TYPES.intent);
      expect(intent.provider_usage_baseline).toMatchObject({ attempt_id: expect.stringContaining("~attempt:1") });
    } finally {
      fixture.db.close();
    }
  });

  test("serializes interrupt races and supersedes only an interrupted Attempt", async () => {
    const fixture = await openFixture("interrupt-race");
    try {
      const run = activeRun(fixture.db, "thread-interrupt", "turn-live");
      const firstCommand = interruptCommand(fixture.db, run, "interrupt-1");
      const prepared = prepareRunInterrupt(fixture.db, firstCommand);
      const racingCommand = { ...interruptCommand(fixture.db, run, "interrupt-2"), expected_revision: 0 };

      expect(() => prepareRunInterrupt(fixture.db, racingCommand)).toThrow("Run revision mismatch");
      expect(completeRunInterrupt(fixture.db, "interrupt-1")).toMatchObject({ completed: true, replayed: false });
      expect(completeRunInterrupt(fixture.db, "interrupt-1")).toMatchObject({ completed: true, replayed: true });
      expect(attempts(fixture.db, run.issue_run_id).at(-1)).toMatchObject({ status: "interrupted" });

      const supersede = newRunCommand(fixture.db, run, "supersede", "supersede-1");
      expect(requestNewRun(fixture.db, supersede)).toMatchObject({ applied: true, replayed: false, requested_sequence: 2 });
      expect(requestNewRun(fixture.db, supersede)).toMatchObject({ applied: true, replayed: true, requested_sequence: 2 });
      expect(issueState(fixture.db, run.issue_id)).toMatchObject({ status: "todo" });
      expect(runState(fixture.db, run.issue_run_id)).toMatchObject({ status: "cancelled" });
      expect(attempts(fixture.db, run.issue_run_id).at(-1)).toMatchObject({ status: "interrupted" });
    } finally {
      fixture.db.close();
    }
  });

  test("deduplicates retry requests and materializes their new Run once", async () => {
    const fixture = await openFixture("retry-materialize");
    try {
      const run = activeRun(fixture.db, "thread-failed", "turn-failed");
      terminalRun(fixture.db, run.issue_run_id, "failed");
      const retry = newRunCommand(fixture.db, run, "retry", "retry-1");

      expect(requestNewRun(fixture.db, retry)).toMatchObject({ applied: true, replayed: false, requested_sequence: 2 });
      expect(requestNewRun(fixture.db, retry)).toMatchObject({ applied: true, replayed: true, requested_sequence: 2 });
      const pending = pendingRunCreation(fixture.db, run.issue_id, 2);
      expect(pending).toMatchObject({ event_id: "retry-1", operation: "retry", supersedes_run_id: run.run_id });

      const next = createIssueRun(fixture.db, run.issue_id);
      if (!pending) throw new Error("pending Run request missing");
      recordRunMaterialized(fixture.db, pending, next.id);
      recordRunMaterialized(fixture.db, pending, next.id);
      expect(pendingRunCreation(fixture.db, run.issue_id, 2)).toBeNull();
      expect(eventCount(fixture.db, "retry-1", RUN_LIFECYCLE_EVENT_TYPES.runRequested)).toBe(1);
      expect(eventCount(fixture.db, "retry-1", RUN_LIFECYCLE_EVENT_TYPES.runMaterialized)).toBe(1);
      expect(runState(fixture.db, next.id)).toMatchObject({ attempt: 2, status: "in_progress" });
    } finally {
      fixture.db.close();
    }
  });
});

type Fixture = { db: RunnerDatabase; stateDir: string };
type ActiveRun = { issue_id: number; issue_run_id: string; run_id: `xw:run:${string}:${string}` };

async function openFixture(slug: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `codex-runner-${slug}-`));
  tempRoots.push(root);
  const stateDir = join(root, "state");
  const db = await openDatabase({ stateDir });
  db.sqlite.run(`insert into projects (id, name, cwd, provider, created_at, updated_at)
    values ('demo', 'demo', ?, 'codex', ?, ?)`, [join(root, "repo"), NOW, NOW]);
  return { db, stateDir };
}

function activeRun(db: RunnerDatabase, sessionID: string, turnID: string): ActiveRun {
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

function attemptCommand(
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
    expected_revision: readRunRevision(db, run.run_id),
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

function interruptCommand(db: RunnerDatabase, run: ActiveRun, eventID: string): RunInterruptCommand {
  const latest = attempts(db, run.issue_run_id).at(-1);
  if (!latest) throw new Error("latest Attempt missing");
  return {
    attempt_id: latest.attempt_id,
    audit: audit(eventID, "interrupt provider turn"),
    expected_attempt_revision: latest.revision,
    expected_revision: readRunRevision(db, run.run_id),
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

function newRunCommand(
  db: RunnerDatabase,
  run: ActiveRun,
  operation: NewRunCommand["operation"],
  eventID: string
): NewRunCommand {
  return {
    audit: audit(eventID, `${operation} Run`),
    expected_revision: readRunRevision(db, run.run_id),
    issue_run_id: run.issue_run_id,
    operation,
    run_id: run.run_id
  };
}

function audit(eventID: string, reason: string): RunTransitionAudit {
  return {
    actor: { id: "runner", kind: "runner" },
    correlation_id: `correlation:${eventID}`,
    event_id: eventID,
    gate: { authority: "deterministic_policy", decision: "allow", policy_ref: "run-lifecycle:p03.04" },
    occurred_at: LATER,
    reason
  };
}

function canonicalRunID(db: RunnerDatabase, issueRunID: string): ActiveRun["run_id"] {
  const row = db.sqlite.query<{ run_id: string }, [string]>("select run_id from issue_runs where id=?").get(issueRunID);
  if (!row?.run_id.startsWith("xw:run:")) throw new Error("canonical Run ID missing");
  return row.run_id as ActiveRun["run_id"];
}

function terminalRun(db: RunnerDatabase, issueRunID: string, status: "failed"): void {
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

function attempts(db: RunnerDatabase, issueRunID: string): Array<Record<string, any>> {
  return db.sqlite.query<Record<string, any>, [string]>(`
    select attempt_id, sequence, kind, status, revision, provider,
      provider_invocation_ref, provider_session_id, provider_turn_id,
      cost_json, ended_at, terminal_reason, terminal_source_ref
    from run_attempts where issue_run_id=? order by sequence
  `).all(issueRunID);
}

function measuredCost(input: number, output: number, cached: number, reasoning: number) {
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

function lifecyclePayload(db: RunnerDatabase, eventID: string, type: string): Record<string, any> {
  const row = db.sqlite.query<{ payload: string }, [string, string]>(`
    select payload from issue_events where type=? and json_extract(payload, '$.event_id')=? limit 1
  `).get(type, eventID);
  return JSON.parse(row?.payload ?? "{}");
}

function eventCount(db: RunnerDatabase, eventID: string, type: string): number {
  return db.sqlite.query<{ count: number }, [string, string]>(`
    select count(*) as count from issue_events
    where type=? and json_valid(payload) and json_extract(payload, '$.event_id')=?
  `).get(type, eventID)?.count ?? 0;
}

function issueState(db: RunnerDatabase, issueID: number): Record<string, unknown> {
  return db.sqlite.query<Record<string, unknown>, [number]>(
    "select id, status, codex_thread_id, codex_turn_id from issues where id=?"
  ).get(issueID) ?? {};
}

function runState(db: RunnerDatabase, issueRunID: string): Record<string, any> {
  return db.sqlite.query<Record<string, any>, [string]>(
    "select id, issue_id, attempt, status, ended_at, exit_reason from issue_runs where id=?"
  ).get(issueRunID) ?? {};
}
