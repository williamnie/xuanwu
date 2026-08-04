import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getAgentSession } from "../db/repositories/agentSessions.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { createPiAction, createPiGuardianEvent, listIssueSupervisorEvents, listPiActions, listPiGuardianDecisions, listPiGuardianEvents, pausePiHeartbeat, upsertProjectPiPolicy } from "../db/repositories/pi.ts";
import { listPiRecoveryAttempts } from "../db/repositories/pi/recoveryAttempts.ts";
import { listNotifications } from "../db/repositories/notifications.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { EventBus, type AppEvent } from "../events/bus.ts";
import type { PiSupervisorDecisionJson } from "../pi/issueSupervisorRecovery.ts";
import type { ExecutorProvider, ProviderRunInput, SessionMessageInput } from "../providers/types.ts";
import {
  createPiAgenticScheduler,
  createPiAutoManageScheduler,
  createPiGuardianScheduler,
  runPiAutoManageCycle,
  runScheduleLayerCycle
} from "./piAutoManageScheduler.ts";
import { runProjectLoopOnce } from "./projectLoop.ts";
import { isProjectLoopActive } from "./projectLoopManager.ts";

class FakePiCycleRunner {
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


class SlowSupervisorDatabase {
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

class FakeClock {
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

const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-bun-pi-auto-scheduler-"));
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
  test("keeps scheduled maintenance deterministic without ambient project LLM sessions", async () => {
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

      expect(runner.calls).toEqual([]);
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
      await waitUntil(() => wrapped.supervisorQueries >= 1 && clock.timers.length === 1);
      const firstScanQueries = wrapped.supervisorQueries;
      await clock.runNext();
      await waitUntil(() => clock.timers.length === 1);

      expect(wrapped.supervisorQueries).toBe(firstScanQueries);
      expect(errors).toEqual([]);
      scheduler.stop();
    } finally {
      db.close();
    }
  });

  test("continues Guardian maintenance without launching project cycles while idle", async () => {
    const db = await openFixtureDatabase();
    const wrapped = new SlowSupervisorDatabase(db);
    const clock = new FakeClock();
    const errors: unknown[] = [];
    const runner = new FakePiCycleRunner();
    try {
      insertProject(db, "enabled", 1);
      insertAgent(db, "pi-default");
      insertSettings(db, "enabled", 1, 2);
      const scheduler = createPiAutoManageScheduler({
        clock,
        database: wrapped as unknown as RunnerDatabase,
        intervalMs: 5,
        onError: (error) => errors.push(error),
        runProjectCycle: runner.run.bind(runner),
        supervisorIntervalMs: 60_000
      });

      scheduler.start();
      for (let tick = 1; tick <= 4; tick += 1) {
        await clock.runNext();
        await waitUntil(() => wrapped.watchdogWrites === tick && clock.timers.length === 1);
      }

      expect(errors).toEqual([]);
      expect(wrapped.watchdogWrites).toBe(4);
      expect(runner.calls).toEqual([]);
      scheduler.stop();
      expect(clock.timers[0]?.canceled).toBe(true);
    } finally {
      db.close();
    }
  });

  test("reports both Guardian and Agentic scheduler cycles as Core maintenance activity", async () => {
    const db = await openFixtureDatabase();
    const guardianClock = new FakeClock();
    const agenticClock = new FakeClock();
    const runner = new FakePiCycleRunner();
    let activityCalls = 0;
    let inFlight = 0;
    const runWithinActivity = async (operation: () => Promise<unknown>) => {
      activityCalls += 1;
      inFlight += 1;
      try {
        return await operation();
      } finally {
        inFlight -= 1;
      }
    };
    try {
      const input = {
        database: db,
        intervalMs: 5,
        runProjectCycle: runner.run.bind(runner),
        runSupervisor: false,
        runWithinActivity
      };
      const guardian = createPiGuardianScheduler({ ...input, clock: guardianClock });
      const agentic = createPiAgenticScheduler({ ...input, clock: agenticClock });

      guardian.start();
      agentic.start();
      await guardianClock.runNext();
      await waitUntil(() => guardianClock.timers.length === 1);
      await agenticClock.runNext();
      await waitUntil(() => agenticClock.timers.length === 1);

      expect(activityCalls).toBe(2);
      expect(inFlight).toBe(0);
      guardian.stop();
      agentic.stop();
    } finally {
      db.close();
    }
  });

  test("keeps Guardian ticking while an independent agentic cycle is awaiting the model", async () => {
    const db = await openFixtureDatabase();
    const wrapped = new SlowSupervisorDatabase(db);
    const guardianClock = new FakeClock();
    const agenticClock = new FakeClock();
    const provider = new ResumeProvider();
    const runner = new FakePiCycleRunner();
    let releaseAgentic = () => {};
    const blocked = new Promise<void>((resolve) => { releaseAgentic = resolve; });
    let agenticActive = false;
    try {
      insertProject(db, "enabled", 1);
      insertAgent(db, "pi-default");
      insertSettings(db, "enabled", 1, 2);
      insertIssueRunSession(db, 519, "enabled");
      const input = {
        database: wrapped as unknown as RunnerDatabase,
        intervalMs: 5,
        providers: { codex: provider },
        runProjectCycle: runner.run.bind(runner),
        runSupervisorDecision: async () => {
          agenticActive = true;
          await blocked;
          agenticActive = false;
          return {
            decision: resumeDecision(),
            raw_text: JSON.stringify(resumeDecision()),
            valid: true
          };
        },
        watchdogNow: NOW
      };
      const guardian = createPiGuardianScheduler({ ...input, clock: guardianClock });
      const agentic = createPiAgenticScheduler({ ...input, clock: agenticClock });

      guardian.start();
      agentic.start();
      await agenticClock.runNext();
      await waitUntil(() => agenticActive);
      expect(agenticClock.timers).toEqual([]);

      await guardianClock.runNext();
      await waitUntil(() => wrapped.watchdogWrites === 1 && guardianClock.timers.length === 1);
      await guardianClock.runNext();
      await waitUntil(() => wrapped.watchdogWrites === 2 && guardianClock.timers.length === 1);

      expect(agenticActive).toBe(true);
      releaseAgentic();
      await waitUntil(() => !agenticActive && agenticClock.timers.length === 1);
      expect(runner.calls).toEqual([]);
      expect(provider.calls).toEqual([{ prompt: expect.stringContaining("继续"), sessionId: "thread-519" }]);
      guardian.stop();
      agentic.stop();
    } finally {
      releaseAgentic();
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

  test("scans every project with a PI binding", async () => {
    const db = await openFixtureDatabase();
    const runner = new FakePiCycleRunner();
    try {
      insertProject(db, "paused", 1);
      insertProject(db, "missing-agent", 1);
      insertProject(db, "enabled", 1);
      insertAgent(db, "pi-default");
      insertSettings(db, "enabled", 1, 3);

      const result = await runPiAutoManageCycle({ database: db, runProjectCycle: runner.run.bind(runner) });

      expect(result).toEqual({ projects: 1, started: 1, skipped: 0 });
      expect(runner.calls).toEqual([{ projectId: "enabled" }]);
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

  test("ignores legacy delegation carriers without launching ambient project cycles", async () => {
    const db = await openFixtureDatabase();
    const runner = new FakePiCycleRunner();
    try {
      insertProject(db, "enabled", 1);
      insertAgent(db, "pi-default");
      insertSettings(db, "enabled", 1, 5);
      insertDelegation(db, "delegation-bad", "missing-project");

      const result = await runScheduleLayerCycle({ database: db, runProjectCycle: runner.run.bind(runner) });

      expect(result.delegations).toEqual({ scanned: 0, started: 0, skipped: 0 });
      expect(result).toMatchObject({ projects: 0, started: 0, skipped: 0, supervisor: { decisions: 0, failed: 0 } });
      expect(runner.calls).toEqual([]);
      expect(heartbeatRunCount(db)).toBe(0);
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
        runSupervisorDecision: async () => ({
          decision: resumeDecision(),
          raw_text: JSON.stringify(resumeDecision()),
          valid: true
        }),
        watchdogNow: NOW
      });

      expect(first.supervisor).toMatchObject({ decisions: 1, failed: 0, signaled: 1 });
      expect(first.guardianActionDispatch).toMatchObject({ completed: 0, failed: 0, scanned: 0 });
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

  test("escalates a deterministic failed autonomous issue instead of spending a blind retry", async () => {
    const db = await openFixtureDatabase();
    const bus = new EventBus();
    const observed: AppEvent[] = [];
    const detach = bus.observe((event) => observed.push(event));
    const runner = new FakePiCycleRunner();
    try {
      insertProject(db, "demo", 0);
      upsertProjectPiPolicy(db, {
        project_id: "demo",
        allowed_supervisor_actions_json: ["issue.retry", "needs_user.escalate"]
      });
      insertSettings(db, "demo", 1, 5);
      insertFailedIssueRunSession(db, 520);

      const first = await runScheduleLayerCycle({
        bus,
        database: db,
        runProjectCycle: runner.run.bind(runner),
        runSupervisorDecision: async () => ({
          decision: needsUserDecision(),
          raw_text: JSON.stringify(needsUserDecision()),
          valid: true
        }),
        watchdogNow: NOW
      });

      expect(first.supervisor).toMatchObject({ decisions: 1, failed: 0, signaled: 1 });
      expect(first.guardianActionDispatch).toMatchObject({ completed: 0, failed: 0, scanned: 0 });
      expect(listPiActions(db, { issueId: 520 })[0]).toMatchObject({
        action_type: "needs_user.escalate",
        status: "completed"
      });
      expect(getIssue(db, 520)).toMatchObject({ status: "failed" });
      expect(listNotifications(db, { projectID: "demo", unreadOnly: true })).toMatchObject([
        expect.objectContaining({ event: "pi.needs_user", issue_id: 520 })
      ]);
      expect(observed).toContainEqual(expect.objectContaining({
        issueId: 520,
        projectId: "demo",
        type: "pi.needs_user"
      }));
      expect(listPiRecoveryAttempts(db, { issueId: 520 })).toEqual([]);
    } finally {
      detach();
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

  test("always-on issue watchdog starts stale todo issues without PI auto-manage settings", async () => {
    const db = await openFixtureDatabase();
    const provider = new WatchdogSessionProvider();
    const runner = new FakePiCycleRunner();
    try {
      insertProject(db, "demo", 1);
      insertTodoIssue(db, 801, "Stale todo", "2026-06-22T08:00:00Z");

      const result = await runScheduleLayerCycle({
        database: db,
        providers: { codex: provider },
        runProjectCycle: runner.run.bind(runner),
        runSupervisor: false,
        watchdogNow: NOW
      });

      expect(result.issueWatchdog).toMatchObject({ candidates: 1, escalated: 0, kicked: 1 });
      expect(runner.calls).toEqual([]);
      await waitUntil(() => provider.inputs.length === 1);
      expect(provider.inputs.map((input) => input.issueId)).toEqual([801]);
      expect(getIssue(db, 801)).toMatchObject({ attempt_count: 1, status: "in_progress" });
      expect(getAgentSession(db, "codex:thread-801")).toMatchObject({ issue_id: 801, status: "running" });
      await waitUntil(() => !isProjectLoopActive("demo"));
    } finally {
      db.close();
    }
  });

  test("always-on issue watchdog re-kicks stale todos that remain sessionless after a kick", async () => {
    const db = await openFixtureDatabase();
    const provider = new WatchdogSessionProvider();
    const runner = new FakePiCycleRunner();
    try {
      insertProject(db, "demo", 1);
      insertTodoIssue(db, 802, "Still stale todo", "2026-06-22T08:00:00Z");
      insertIssueWatchdogKick(db, 802, "2026-06-22T08:10:00Z");

      const result = await runScheduleLayerCycle({
        database: db,
        providers: { codex: provider },
        runProjectCycle: runner.run.bind(runner),
        runSupervisor: false,
        watchdogNow: NOW
      });

      expect(result.issueWatchdog).toMatchObject({ candidates: 1, escalated: 0, kicked: 1 });
      await waitUntil(() => provider.inputs.length === 1);
      expect(provider.inputs.map((input) => input.issueId)).toEqual([802]);
      expect(listNotifications(db, { projectID: "demo", unreadOnly: true })).toEqual([]);
      await waitUntil(() => !isProjectLoopActive("demo"));
    } finally {
      db.close();
    }
  });

  test("routes a provider initialize outage to PI acceptance without a hardcoded retry", async () => {
    const db = await openFixtureDatabase();
    const provider = new InitializeTimeoutProvider();
    const runner = new FakePiCycleRunner();
    try {
      insertProviderOutageRegressionProject(db);

      await runProjectLoopOnce({
        database: db,
        projectId: "demo",
        providers: { claude: provider }
      });

      expectDeferredOutageClaim(db, provider);

      const result = await runOutageScheduleClosure(db, runner);

      expect(result.first.supervisor).toMatchObject({ scanned: 0, signaled: 0 });
      expect(result.first.guardianDecisions).toMatchObject({ created: 1 });
      expect(result.second.guardianActionDispatch).toMatchObject({ completed: 0, failed: 0, scanned: 0 });
      expect(runner.calls).toEqual([]);
      expect(getIssue(db, 702)).toMatchObject({ attempt_count: 0, status: "todo" });

      expect(listPiActions(db, { issueId: 701 })).toEqual([]);
      expect(getIssue(db, 701)).toMatchObject({
        auto_retry_reason: "",
        status: "in_progress"
      });
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
      expect(runner.calls).toEqual([{ projectId: "enabled" }]);
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
  insertProjectFixture(db, { autoRun, id, provider: "codex" });
}

function insertProjectFixture(db: DB, input: { autoRun: number; id: string; provider: string }): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, auto_run, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.id, input.id, `/tmp/${input.id}`, input.provider, input.autoRun, input.autoRun,
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertProviderOutageRegressionProject(db: DB): void {
  insertProjectFixture(db, { autoRun: 1, id: "demo", provider: "claude" });
  insertTodoIssue(db, 701, "Provider outage first", "2026-06-22T08:00:00Z");
  insertTodoIssue(db, 702, "Ordinary follow-up", "2026-06-22T08:01:00Z");
}

function insertTodoIssue(db: DB, id: number, title: string, createdAt: string): void {
  db.sqlite.run(`insert into issues (id, project_id, title, status, created_at, updated_at)
    values (?, 'demo', ?, 'todo', ?, ?)`, [id, title, createdAt, createdAt]);
}

function insertIssueWatchdogKick(db: DB, issueID: number, createdAt: string): void {
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [issueID, "issue.watchdog_kicked", JSON.stringify({ reason: "test" }), createdAt]
  );
}

function insertSettings(db: DB, projectID: string, _autoManage: number, _maxActions: number, _agentID = "pi-default"): void {
  db.sqlite.run(
    `insert into project_pi_settings (project_id, created_at, updated_at) values (?, ?, ?)`,
    [projectID, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

const NOW = new Date("2026-06-22T08:40:00Z");

function resumeDecision(): PiSupervisorDecisionJson {
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

function needsUserDecision(): PiSupervisorDecisionJson {
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

async function runOutageScheduleClosure(db: DB, runner: FakePiCycleRunner) {
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

function expectDeferredOutageClaim(db: DB, provider: InitializeTimeoutProvider): void {
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

function insertIssueRunSession(db: DB, issueID: number, projectID = "demo"): void {
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

function insertFailedIssueRunSession(db: DB, issueID: number): void {
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

class InitializeTimeoutProvider implements ExecutorProvider {
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

class WatchdogSessionProvider implements ExecutorProvider {
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
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met");
}
