import { expect } from "bun:test";
import { type RunnerDatabase } from "../db/database.ts";

import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";

import { listIssueEvents } from "../db/repositories/issueEvents.ts";

import type { PiSupervisorDecisionJson } from "../pi/supervisor/issueSupervisorRecovery.ts";
import type { ExecutorProvider, ProviderRunInput, SessionMessageInput } from "../providers/types.ts";
import { runScheduleLayerCycle } from "./piAutoManageScheduler.ts";

import { insertRow, useTestDatabase, waitFor } from "../testing/harness.ts";

export class FakePiCycleRunner {
  active = 0;
  readonly calls: Array<{ maxActions?: number; projectId: string }> = [];
  deferred: Promise<void> | undefined;

  async run(input: { maxActions?: number; projectId: string }) {
    if (this.active > 0) throw new Error("reentrant project cycle");
    this.active += 1;
    this.calls.push(input);
    await this.deferred;
    this.active -= 1;
    return { status: "completed" };
  }
}

export class SlowSupervisorDatabase {
  readonly path: string; readonly readonly: boolean; readonly sqlite;
  supervisorQueries = 0;
  watchdogWrites = 0;

  constructor(readonly inner: RunnerDatabase) {
    this.path = inner.path; this.readonly = inner.readonly;
    const run = inner.sqlite.run.bind(inner.sqlite) as (...args: any[]) => unknown;
    this.sqlite = new Proxy(inner.sqlite, {
      get: (target, property) => {
        if (property === "query") return (sql: string) => {
          if (sql.includes("join project_pi_settings settings")) this.supervisorQueries += 1;
          return inner.sqlite.query(sql);
        };
        if (property === "run") return (sql: string, ...bindings: any[]) => {
          if (sql.includes("pi_guardian_watchdog_status")) this.watchdogWrites += 1;
          return run(sql, ...bindings);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
  }
  close(): void { this.inner.close(); }
  transaction(inside: Parameters<RunnerDatabase["transaction"]>[0]) { return this.inner.transaction(inside); }
}

export class FakeClock {
  readonly timers: Array<{ callback: () => void | Promise<void>; canceled: boolean; delayMs: number }> = [];

  setTimeout(callback: () => void | Promise<void>, delayMs: number) {
    const timer = { callback, canceled: false, delayMs };
    this.timers.push(timer);
    return timer;
  }

  clearTimeout(timer: { canceled: boolean }): void {
    timer.canceled = true;
  }

  async runNext(): Promise<void> {
    const timer = this.timers.shift();
    if (!timer || timer.canceled) return;
    void timer.callback();
    for (let index = 0; index < 50 && this.timers.length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

export const openFixtureDatabase = useTestDatabase();

export type DB = RunnerDatabase;

export const CREATED = "2026-01-01T00:00:00Z";

export function insertProject(db: DB, id: string, autoRun: number, provider = "codex"): void {
  insertRow(db, "projects", { id, name: id, cwd: `/tmp/${id}`, provider, auto_run: autoRun, sort_order: autoRun, created_at: CREATED, updated_at: CREATED });
}

export function insertManagedProject(db: DB, id: string): void {
  insertProject(db, id, 1);
  insertRow(db, "pi_agents", { id: "pi-default", name: "pi-default", enabled: 1, created_at: CREATED, updated_at: CREATED });
  insertSettings(db, id);
}

export function insertTodoIssue(db: DB, id: number, title: string, createdAt: string): void {
  insertRow(db, "issues", { id, project_id: "demo", title, status: "todo", created_at: createdAt, updated_at: createdAt });
}

export function insertSettings(db: DB, projectID: string): void {
  insertRow(db, "project_pi_settings", { project_id: projectID, created_at: CREATED, updated_at: CREATED });
}

export const NOW = new Date("2026-06-22T08:40:00Z");

export function validDecision(decision: PiSupervisorDecisionJson) {
  return { decision, raw_text: JSON.stringify(decision), valid: true };
}

export function resumeDecision(): PiSupervisorDecisionJson {
  return {
    confidence: "high",
    decision: "resume_session",
    evidence_refs: ["latest_run", "session"],
    expected_outcome: "the existing provider session continues",
    fallback_if_no_progress: "needs_user",
    rationale: "PI verified that the existing session can safely resume",
    recovery_message: "检查当前状态后继续未完成工作。",
    risk_level: "medium"
  };
}

export function needsUserDecision(): PiSupervisorDecisionJson {
  return {
    confidence: "high",
    decision: "needs_user",
    evidence_refs: ["latest_run", "provider_error"],
    expected_outcome: "a human reviews the deterministic executor failure",
    fallback_if_no_progress: "blocked",
    rationale: "the executor failure requires a human decision",
    recovery_message: "执行失败需要人工确认，未自动重试。",
    risk_level: "medium"
  };
}

export async function runOutageScheduleClosure(db: DB, runner: FakePiCycleRunner) {
  const first = await runScheduleLayerCycle({
    database: db,
    runProjectCycle: runner.run.bind(runner),
    watchdogNow: NOW
  });
  db.sqlite.run("update pi_guardian_decisions set cooldown_until='' where project_id='demo'");
  const second = await runScheduleLayerCycle({
    database: db,
    runProjectCycle: runner.run.bind(runner),
    runSupervisor: false,
    watchdogNow: new Date(NOW.getTime() + 31_000)
  });
  return { first, second };
}

export function expectDeferredOutageClaim(db: DB, provider: InitializeTimeoutProvider): void {
  expect(provider.inputs.map((input) => input.issueId)).toEqual([701]);
  expect(getIssue(db, 701)).toMatchObject({
    auto_retry_reason: "",
    status: "in_progress"
  });
  expect(listIssueRuns(db, 701).at(-1)).toMatchObject({
    ended_at: expect.not.stringMatching(/^$/),
    exit_reason: "provider_reported_failed",
    provider: "claude",
    status: "failed"
  });
  expect(getIssue(db, 702)).toMatchObject({ attempt_count: 0, status: "todo" });
  expect(listIssueRuns(db, 702)).toEqual([]);
  expect(listIssueEvents(db, 701).map((event) => event.type)).toContain("issue.pi_acceptance_requested.v1");
  expect(listIssueEvents(db, 701).map((event) => event.type)).not.toContain("issue.provider_deferred");
}

export function insertIssueRunSession(db: DB, issueID: number, projectID = "demo"): void {
  db.sqlite.run(`insert into issues (id, project_id, title, status, created_at, updated_at)
    values (?, ?, 'Idle issue', 'in_progress', ?, ?)`, [issueID, projectID, "2026-06-22T08:00:00Z", "2026-06-22T08:35:07Z"]);
  db.sqlite.run(`insert into issue_runs
    (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id, started_at, ended_at)
    values (?, ?, 1, 'in_progress', 'codex', ?, ?, ?, '')`,
  [`issue-${issueID}-attempt-1`, issueID, `thread-${issueID}`, `turn-${issueID}`, "2026-06-22T08:15:07Z"]);
  db.sqlite.run(`insert into agent_sessions
    (session_key, provider, provider_session_id, agent_role, project_id, issue_id, status, raw_ref, created_at, updated_at)
    values (?, 'codex', ?, 'executor', ?, ?, 'idle', ?, ?, ?)`,
  [`codex:thread-${issueID}`, `thread-${issueID}`, projectID, issueID, JSON.stringify({ provider_turn_id: `turn-${issueID}` }),
    "2026-06-22T08:15:07Z", "2026-06-22T08:35:07Z"]);
}

export function insertFailedIssueRunSession(db: DB, issueID: number): void {
  db.sqlite.run(`insert into issues (id, project_id, title, status, attempt_count, error, created_at, updated_at)
    values (?, 'demo', 'Failed autonomous issue', 'failed', 1, 'focused tests failed', ?, ?)`,
  [issueID, "2026-06-22T08:00:00Z", "2026-06-22T08:35:07Z"]);
  db.sqlite.run(`insert into issue_runs
    (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id, started_at, ended_at, error)
    values (?, ?, 1, 'failed', 'codex', ?, ?, ?, ?, 'focused tests failed')`,
  [`issue-${issueID}-attempt-1`, issueID, `thread-${issueID}`, `turn-${issueID}`,
    "2026-06-22T08:15:07Z", "2026-06-22T08:35:07Z"]);
  db.sqlite.run(`insert into agent_sessions
    (session_key, provider, provider_session_id, agent_role, project_id, issue_id, status, raw_ref, created_at, updated_at)
    values (?, 'codex', ?, 'executor', 'demo', ?, 'failed', ?, ?, ?)`,
  [`codex:thread-${issueID}`, `thread-${issueID}`, issueID,
    JSON.stringify({ provider_turn_id: `turn-${issueID}` }), "2026-06-22T08:15:07Z", "2026-06-22T08:35:07Z"]);
  db.sqlite.run(`insert into issue_events (issue_id, type, payload, created_at) values (?, 'issue.log', ?, ?)`, [
    issueID,
    JSON.stringify({ provider: "codex", raw_payload: "focused test failed", status: "failed", type: "error" }),
    "2026-06-22T08:35:06Z"
  ]);
}

export class ResumeProvider implements ExecutorProvider {
  readonly capabilities = ["issue_execution", "resume_session"] as const;
  readonly calls: Array<{ prompt: string; sessionId: string }> = [];
  readonly id = "codex" as const;
  async run(input: ProviderRunInput) { return { runId: `codex-run-${input.issueId}` }; }
  async readSession(sessionId: string) { return { provider_session_id: sessionId, provider_turn_id: "turn-519", sessionId }; }
  async recover(input: Parameters<NonNullable<ExecutorProvider["recover"]>>[0]) {
    const result = await this.sendSessionMessage({ prompt: input.prompt, sessionId: input.session.sessionId });
    return { runId: `codex:${result.sessionId}:${result.turn_id}`,
      session: { provider: this.id, sessionId: result.sessionId, turnId: result.turn_id } };
  }
  async sendSessionMessage(input: SessionMessageInput) {
    this.calls.push({ prompt: input.prompt || "", sessionId: input.sessionId });
    return { provider: "codex" as const, provider_session_id: input.sessionId, sessionId: input.sessionId, turn_id: "turn-followup" };
  }
}

export class InitializeTimeoutProvider implements ExecutorProvider {
  readonly capabilities = ["issue_execution"] as const;
  readonly id = "claude" as const;
  readonly inputs: ProviderRunInput[] = [];

  async run(input: ProviderRunInput) {
    this.inputs.push(input);
    throw new Error(
      "Claude Code run timed out after 10000ms: initialize cwd=/Users/xiaobei/private token=sk-live-secret"
    );
  }
}

export class WatchdogSessionProvider implements ExecutorProvider {
  readonly capabilities = ["issue_execution"] as const;
  readonly id = "codex" as const;
  readonly inputs: ProviderRunInput[] = [];

  async run(input: ProviderRunInput) {
    this.inputs.push(input);
    return {
      runId: `run-${input.issueId}`,
      session: { provider: this.id, sessionId: `thread-${input.issueId}`, turnId: `turn-${input.issueId}` }
    };
  }
}

export function insertDelegation(db: DB, id: string, projectID: string): void {
  insertRow(db, "pi_delegations", {
    id, project_id: projectID, title: "Delegation", status: "active", intent_json: "{}", authorization_json: "{}",
    next_heartbeat_at: CREATED, created_at: CREATED, updated_at: CREATED
  });
}

export function heartbeatRunCount(db: DB): number {
  return db.sqlite.query<{ count: number }, []>("select count(*) as count from pi_heartbeat_runs").get()?.count ?? 0;
}

export function waitUntil(predicate: () => boolean): Promise<unknown> {
  return waitFor(predicate, "condition was not met", 200, 0);
}
