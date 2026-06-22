import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createPiAction, createPiGuardianEvent, listIssueSupervisorEvents, listPiActions, listPiGuardianDecisions, listPiGuardianEvents, pausePiHeartbeat } from "../db/repositories/pi.ts";
import { listNotifications } from "../db/repositories/notifications.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import type { ExecutorProvider, ProviderRunInput, SessionMessageInput } from "../providers/types.ts";
import { createPiAutoManageScheduler, runPiAutoManageCycle, runScheduleLayerCycle } from "./piAutoManageScheduler.ts";

class FakePiCycleRunner {
  active = 0;
  readonly calls: Array<{ maxActions: number; projectId: string }> = [];
  deferred: Promise<void> | undefined;

  async run(input: { maxActions: number; projectId: string }) {
    if (this.active > 0) throw new Error("reentrant project cycle");
    this.active += 1;
    this.calls.push(input);
    await this.deferred;
    this.active -= 1;
    return { status: "completed" };
  }
}


class SlowSupervisorDatabase {
  readonly path: string; readonly readonly: boolean; readonly sqlite; supervisorQueries = 0;
  constructor(readonly inner: RunnerDatabase) {
    this.path = inner.path; this.readonly = inner.readonly;
    this.sqlite = {
      query: (sql: string) => {
        if (sql.includes("auto_retry_next_at")) this.supervisorQueries += 1;
        return inner.sqlite.query(sql);
      },
      run: inner.sqlite.run.bind(inner.sqlite)
    };
  }
  close(): void { this.inner.close(); }
  transaction(inside: Parameters<RunnerDatabase["transaction"]>[0]) { return this.inner.transaction(inside); }
}

class FakeClock {
  readonly timers: Array<{ callback: () => void; canceled: boolean; delayMs: number }> = [];

  setTimeout(callback: () => void, delayMs: number) {
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
    timer.callback();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-pi-auto-scheduler-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI auto-manage scheduler", () => {
  test("runs scheduled cycles with a fake clock", async () => {
    const db = await openFixtureDatabase();
    const runner = new FakePiCycleRunner();
    const clock = new FakeClock();
    try {
      insertProject(db, "enabled", 1);
      insertAgent(db, "pi-default");
      insertSettings(db, "enabled", 1, 4);
      const scheduler = createPiAutoManageScheduler({
        clock,
        database: db,
        intervalMs: 1000,
        runProjectCycle: runner.run.bind(runner)
      });

      scheduler.start();
      expect(clock.timers.map((timer) => timer.delayMs)).toEqual([1000]);
      await clock.runNext();

      expect(runner.calls).toEqual([{ projectId: "enabled", maxActions: 4 }]);
      await waitUntil(() => clock.timers.length === 1);
      scheduler.stop();
      expect(clock.timers[0]?.canceled).toBe(true);
    } finally {
      db.close();
    }
  });

  test("throttles supervisor scans separately from the faster schedule tick", async () => {
    const db = await openFixtureDatabase();
    const wrapped = new SlowSupervisorDatabase(db);
    const runner = new FakePiCycleRunner();
    const clock = new FakeClock();
    const errors: unknown[] = [];
    try {
      const scheduler = createPiAutoManageScheduler({
        clock, database: wrapped as unknown as RunnerDatabase, intervalMs: 1000,
        onError: (error) => errors.push(error), runProjectCycle: runner.run.bind(runner),
        supervisorIntervalMs: 60_000
      });

      scheduler.start();
      await clock.runNext();
      await waitUntil(() => wrapped.supervisorQueries === 1 && clock.timers.length === 1);
      await clock.runNext();
      await waitUntil(() => clock.timers.length === 1);

      expect(wrapped.supervisorQueries).toBe(1);
      expect(errors).toEqual([]);
      scheduler.stop();
    } finally {
      db.close();
    }
  });

  test("idles safely when there are no enabled projects", async () => {
    const db = await openFixtureDatabase();
    const runner = new FakePiCycleRunner();
    try {
      const result = await runPiAutoManageCycle({ database: db, runProjectCycle: runner.run.bind(runner) });

      expect(result).toEqual({ projects: 0, started: 0, skipped: 0 });
      expect(runner.calls).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("scans auto-managed projects and passes max_actions_per_cycle", async () => {
    const db = await openFixtureDatabase();
    const runner = new FakePiCycleRunner();
    try {
      insertProject(db, "paused", 1);
      insertProject(db, "missing-agent", 1);
      insertProject(db, "enabled", 1);
      insertAgent(db, "pi-default");
      insertSettings(db, "paused", 0, 9);
      insertSettings(db, "missing-agent", 1, 8, "pi-missing");
      insertSettings(db, "enabled", 1, 3);

      const result = await runPiAutoManageCycle({ database: db, runProjectCycle: runner.run.bind(runner) });

      expect(result).toEqual({ projects: 1, started: 1, skipped: 0 });
      expect(runner.calls).toEqual([{ projectId: "enabled", maxActions: 3 }]);
    } finally {
      db.close();
    }
  });

  test("does not run auto-managed project cycles while heartbeat is paused", async () => {
    const db = await openFixtureDatabase();
    const runner = new FakePiCycleRunner();
    try {
      insertProject(db, "paused-heartbeat", 1);
      insertAgent(db, "pi-default");
      insertSettings(db, "paused-heartbeat", 1, 7);
      pausePiHeartbeat(db, { scopeId: "paused-heartbeat", scopeType: "project" });

      const result = await runPiAutoManageCycle({ database: db, runProjectCycle: runner.run.bind(runner) });

      expect(result).toEqual({ projects: 1, started: 0, skipped: 1 });
      expect(runner.calls).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("continues auto-manage when one delegation heartbeat fails", async () => {
    const db = await openFixtureDatabase();
    const runner = new FakePiCycleRunner();
    try {
      insertProject(db, "enabled", 1);
      insertAgent(db, "pi-default");
      insertSettings(db, "enabled", 1, 5);
      insertDelegation(db, "delegation-bad", "missing-project");

      const result = await runScheduleLayerCycle({ database: db, runProjectCycle: runner.run.bind(runner) });

      expect(result.delegations).toMatchObject({ scanned: 1, started: 1, skipped: 0 });
      expect(result).toMatchObject({ projects: 1, started: 1, skipped: 0, supervisor: { decisions: 0, failed: 0 } });
      expect(runner.calls).toEqual([{ maxActions: 5, projectId: "enabled" }]);
    } finally {
      db.close();
    }
  });

  test("runs Guardian decision merge during schedule layer cycles", async () => {
    const db = await openFixtureDatabase();
    const runner = new FakePiCycleRunner();
    try {
      createPiGuardianEvent(db, {
        event_type: "guardian.supervisor.candidate",
        id: "scheduled-guardian-signal",
        idempotency_key: "guardian.supervisor.candidate:demo:901:scheduled",
        issue_id: 901,
        normalized_payload_json: { diagnosis_code: "provider_timeout" },
        project_id: "demo",
        severity: "watch",
        source: "supervisor",
        source_event_id: "scheduled-guardian-signal",
        status: "pending"
      });

      const result = await runScheduleLayerCycle({ database: db, runProjectCycle: runner.run.bind(runner) });

      expect(result.guardianDecisions).toMatchObject({ created: 1, scanned: 1 });
      expect(listPiGuardianDecisions(db, { issueId: 901, projectId: "demo" })).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("drains the pending Guardian inbox during one schedule layer cycle", async () => {
    const db = await openFixtureDatabase();
    const runner = new FakePiCycleRunner();
    try {
      for (let index = 1; index <= 55; index += 1) {
        createPiGuardianEvent(db, {
          event_type: "guardian.supervisor.candidate",
          id: `scheduled-guardian-signal-${index}`,
          idempotency_key: `guardian.supervisor.candidate:demo:${1000 + index}:scheduled`,
          issue_id: 1000 + index,
          normalized_payload_json: { diagnosis_code: "provider_timeout" },
          project_id: "demo",
          severity: "urgent",
          source: "supervisor",
          source_event_id: `scheduled-guardian-signal-${index}`,
          status: "pending"
        });
      }

      const result = await runScheduleLayerCycle({ database: db, runProjectCycle: runner.run.bind(runner) });

      expect(result.guardianDecisions).toMatchObject({ created: 55, scanned: 55 });
      expect(listPiGuardianEvents(db, { projectId: "demo", status: "pending" })).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("executes approved supervisor resume follow-up during schedule layer cycle", async () => {
    const db = await openFixtureDatabase();
    const provider = new ResumeProvider();
    const runner = new FakePiCycleRunner();
    try {
      insertProject(db, "demo", 1);
      insertIssueRunSession(db, 519);
      insertSettings(db, "demo", 0, 5);

      const first = await runScheduleLayerCycle({
        database: db,
        providers: { codex: provider },
        runProjectCycle: runner.run.bind(runner),
        watchdogNow: NOW
      });
      db.sqlite.run("update pi_guardian_decisions set cooldown_until='' where project_id='demo'");
      const second = await runScheduleLayerCycle({
        database: db,
        providers: { codex: provider },
        runProjectCycle: runner.run.bind(runner),
        runSupervisor: false,
        watchdogNow: new Date(NOW.getTime() + 31_000)
      });

      expect(first.supervisor).toMatchObject({ signaled: 1 });
      expect(second.guardianActionDispatch).toMatchObject({ completed: 1, failed: 0, scanned: 1 });
      expect(provider.calls).toEqual([{ prompt: expect.stringContaining("继续"), sessionId: "thread-519" }]);
      expect(listPiActions(db, { issueId: 519 })[0]).toMatchObject({
        action_type: "session.resume_followup",
        status: "completed"
      });
      expect(listIssueSupervisorEvents(db, { issueId: 519 }).map((event) => event.event_type)).toContain("result");
    } finally {
      db.close();
    }
  });

  test("executes approved Guardian needs-user escalation during schedule layer cycle", async () => {
    const db = await openFixtureDatabase();
    const runner = new FakePiCycleRunner();
    try {
      insertProject(db, "demo", 0);
      db.sqlite.run(`insert into issues (id, project_id, title, status, created_at, updated_at)
        values (611, 'demo', 'Needs user issue', 'in_progress', ?, ?)`,
      ["2026-06-22T08:00:00Z", "2026-06-22T08:35:07Z"]);
      createPiAction(db, {
        action_type: "needs_user.escalate",
        gate_decision: "execute",
        id: "guardian-needs-user",
        issue_id: 611,
        payload_json: JSON.stringify({
          diagnosis_code: "provider_auth_failed",
          issue_id: 611,
          message: "Provider unavailable",
          next_step: "Refresh provider credentials.",
          provider: "codex"
        }),
        project_id: "demo",
        source: "pi_guardian_orchestrator",
        status: "approved"
      });

      const result = await runScheduleLayerCycle({
        database: db,
        runProjectCycle: runner.run.bind(runner),
        runSupervisor: false,
        watchdogNow: NOW
      });

      expect(result.guardianActionDispatch).toMatchObject({ completed: 1, failed: 0, scanned: 1 });
      expect(listPiActions(db, { issueId: 611 })[0]).toMatchObject({
        action_type: "needs_user.escalate",
        status: "completed"
      });
      expect(listNotifications(db, { projectID: "demo", unreadOnly: true })).toMatchObject([
        expect.objectContaining({ event: "pi.needs_user", issue_id: 611 })
      ]);
      expect(listIssueEvents(db, 611).filter((event) => event.type === "issue.comment")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("does not run delegation heartbeats while project heartbeat is paused", async () => {
    const db = await openFixtureDatabase();
    const runner = new FakePiCycleRunner();
    try {
      insertProject(db, "project-a", 1);
      insertDelegation(db, "delegation-paused", "project-a");
      pausePiHeartbeat(db, { scopeId: "project-a", scopeType: "project" });

      const result = await runScheduleLayerCycle({ database: db, runProjectCycle: runner.run.bind(runner) });

      expect(result.delegations).toEqual({ scanned: 0, skipped: 0, started: 0 });
      expect(result.supervisor).toMatchObject({ decisions: 0, failed: 0 });
      expect(heartbeatRunCount(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  test("skips reentrant cycles for the same project", async () => {
    const db = await openFixtureDatabase();
    const runner = new FakePiCycleRunner();
    let release!: () => void;
    runner.deferred = new Promise<void>((resolve) => { release = resolve; });
    try {
      insertProject(db, "enabled", 1);
      insertAgent(db, "pi-default");
      insertSettings(db, "enabled", 1, 2);

      const first = runPiAutoManageCycle({ database: db, runProjectCycle: runner.run.bind(runner) });
      await waitUntil(() => runner.active === 1);
      const second = await runPiAutoManageCycle({ database: db, runProjectCycle: runner.run.bind(runner) });
      release();

      expect(await first).toEqual({ projects: 1, started: 1, skipped: 0 });
      expect(second).toEqual({ projects: 1, started: 0, skipped: 1 });
      expect(runner.calls).toEqual([{ projectId: "enabled", maxActions: 2 }]);
    } finally {
      db.close();
    }
  });
});

type DB = RunnerDatabase;

function insertAgent(db: DB, id: string): void {
  db.sqlite.run(
    `insert into pi_agents (id, name, enabled, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [id, id, 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertProject(db: DB, id: string, autoRun: number): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, auto_run, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, autoRun, autoRun, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertSettings(db: DB, projectID: string, autoManage: number, maxActions: number, agentID = "pi-default"): void {
  db.sqlite.run(
    `insert into project_pi_settings
     (project_id, pi_agent_id, auto_manage, max_actions_per_cycle, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [projectID, agentID, autoManage, maxActions, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

const NOW = new Date("2026-06-22T08:40:00Z");

function insertIssueRunSession(db: DB, issueID: number): void {
  db.sqlite.run(`insert into issues (id, project_id, title, status, created_at, updated_at)
    values (?, 'demo', 'Idle issue', 'in_progress', ?, ?)`, [issueID, "2026-06-22T08:00:00Z", "2026-06-22T08:35:07Z"]);
  db.sqlite.run(`insert into issue_runs
    (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id, started_at, ended_at)
    values (?, ?, 1, 'in_progress', 'codex', ?, ?, ?, '')`,
  [`issue-${issueID}-attempt-1`, issueID, `thread-${issueID}`, `turn-${issueID}`, "2026-06-22T08:15:07Z"]);
  db.sqlite.run(`insert into agent_sessions
    (session_key, provider, provider_session_id, agent_role, project_id, issue_id, status, raw_ref, created_at, updated_at)
    values (?, 'codex', ?, 'executor', 'demo', ?, 'idle', ?, ?, ?)`,
  [`codex:thread-${issueID}`, `thread-${issueID}`, issueID, JSON.stringify({ provider_turn_id: `turn-${issueID}` }),
    "2026-06-22T08:15:07Z", "2026-06-22T08:35:07Z"]);
}

class ResumeProvider implements ExecutorProvider {
  readonly capabilities = ["issue_execution", "resume_session"] as const;
  readonly calls: Array<{ prompt: string; sessionId: string }> = [];
  readonly id = "codex" as const;
  async run(input: ProviderRunInput) { return { runId: `codex-run-${input.issueId}` }; }
  async readSession(sessionId: string) { return { provider_session_id: sessionId, provider_turn_id: "turn-519", sessionId }; }
  async sendSessionMessage(input: SessionMessageInput) {
    this.calls.push({ prompt: input.prompt || "", sessionId: input.sessionId });
    return { provider: "codex" as const, provider_session_id: input.sessionId, sessionId: input.sessionId, turn_id: "turn-followup" };
  }
}

function insertDelegation(db: DB, id: string, projectID: string): void {
  db.sqlite.run(
    `insert into pi_delegations
     (id, project_id, title, status, intent_json, authorization_json, next_heartbeat_at, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, projectID, "Delegation", "active", "{}", "{}", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function heartbeatRunCount(db: DB): number {
  return db.sqlite.query<{ count: number }, []>("select count(*) as count from pi_heartbeat_runs").get()?.count ?? 0;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met");
}
