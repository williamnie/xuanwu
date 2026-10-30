import { expect, test } from "bun:test";
import { type RunnerDatabase } from "../db/database.ts";

import {
  createPiGuardianEvent,
  listIssueSupervisorEvents,
  listPiActions,
  listPiGuardianDecisions,
  listPiGuardianEvents,
  pausePiHeartbeat
} from "../db/repositories/pi.ts";

import {
  createPiAgenticScheduler,
  createPiGuardianScheduler,
  runPiAutoManageCycle,
  runScheduleLayerCycle
} from "./piAutoManageScheduler.ts";

import {
  FakePiCycleRunner,
  SlowSupervisorDatabase,
  FakeClock,
  openFixtureDatabase,
  insertProject,
  insertManagedProject,
  insertSettings,
  NOW,
  validDecision,
  resumeDecision,
  insertIssueRunSession,
  ResumeProvider,
  insertDelegation,
  heartbeatRunCount,
  waitUntil
} from "./piAutoManageSchedulerTestFixtures.ts";

export function registerPiAutoManageSchedulerConcurrencyCases() {
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
      insertManagedProject(db, "enabled");
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
          return validDecision(resumeDecision());
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
    }
  });

  test("idles safely when there are no enabled projects", async () => {
    const db = await openFixtureDatabase();
    const runner = new FakePiCycleRunner();
    const result = await runPiAutoManageCycle({ database: db, runProjectCycle: runner.run.bind(runner) });

    expect(result).toEqual({ projects: 0, started: 0, skipped: 0 });
    expect(runner.calls).toEqual([]);
  });

  test("scans every project with a PI binding", async () => {
    const db = await openFixtureDatabase();
    const runner = new FakePiCycleRunner();
    insertProject(db, "paused", 1);
    insertProject(db, "missing-agent", 1);
    insertManagedProject(db, "enabled");

    const result = await runPiAutoManageCycle({ database: db, runProjectCycle: runner.run.bind(runner) });

    expect(result).toEqual({ projects: 1, started: 1, skipped: 0 });
    expect(runner.calls).toEqual([{ projectId: "enabled" }]);
  });

  test("does not run auto-managed project cycles while heartbeat is paused", async () => {
    const db = await openFixtureDatabase();
    const runner = new FakePiCycleRunner();
    insertManagedProject(db, "paused-heartbeat");
    pausePiHeartbeat(db, { scopeId: "paused-heartbeat", scopeType: "project" });

    const result = await runPiAutoManageCycle({ database: db, runProjectCycle: runner.run.bind(runner) });

    expect(result).toEqual({ projects: 1, started: 0, skipped: 1 });
    expect(runner.calls).toEqual([]);
  });

  test("ignores legacy delegation carriers without launching ambient project cycles", async () => {
    const db = await openFixtureDatabase();
    const runner = new FakePiCycleRunner();
    insertManagedProject(db, "enabled");
    insertDelegation(db, "delegation-bad", "missing-project");

    const result = await runScheduleLayerCycle({ database: db, runProjectCycle: runner.run.bind(runner) });

    expect(result.delegations).toEqual({ scanned: 0, started: 0, skipped: 0 });
    expect(result).toMatchObject({ projects: 0, started: 0, skipped: 0, supervisor: { decisions: 0, failed: 0 } });
    expect(runner.calls).toEqual([]);
    expect(heartbeatRunCount(db)).toBe(0);
  });

  test("runs Guardian decision merge during schedule layer cycles", async () => {
    const db = await openFixtureDatabase();
    const runner = new FakePiCycleRunner();
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
  });

  test("drains the pending Guardian inbox during one schedule layer cycle", async () => {
    const db = await openFixtureDatabase();
    const runner = new FakePiCycleRunner();
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
  });

  test("executes approved supervisor resume follow-up during schedule layer cycle", async () => {
    const db = await openFixtureDatabase();
    const provider = new ResumeProvider();
    const runner = new FakePiCycleRunner();
    insertProject(db, "demo", 1);
    insertIssueRunSession(db, 519);
    insertSettings(db, "demo");

    const first = await runScheduleLayerCycle({
      database: db,
      providers: { codex: provider },
      runProjectCycle: runner.run.bind(runner),
      runSupervisorDecision: async () => validDecision(resumeDecision()),
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
  });
}
