import { expect, test } from "bun:test";
import { type RunnerDatabase } from "../db/database.ts";

import { getPiGuardianWatchdogStatus } from "../db/repositories/pi.ts";

import {
  createPiAgenticScheduler,
  createPiAutoManageScheduler,
  createPiGuardianScheduler
} from "./piAutoManageScheduler.ts";

import {
  FakePiCycleRunner,
  SlowSupervisorDatabase,
  FakeClock,
  openFixtureDatabase,
  insertManagedProject,
  waitUntil
} from "./piAutoManageSchedulerTestFixtures.ts";

export function registerPiAutoManageSchedulerSchedulingCases() {
  test("keeps scheduled maintenance deterministic without ambient project LLM sessions", async () => {
    const db = await openFixtureDatabase();
    const runner = new FakePiCycleRunner();
    const clock = new FakeClock();
    insertManagedProject(db, "enabled");
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
  });

  test("guardian refreshes the watchdog heartbeat immediately on start", async () => {
    const db = await openFixtureDatabase();
    const runner = new FakePiCycleRunner();
    const clock = new FakeClock();
    const scheduler = createPiGuardianScheduler({
      clock,
      database: db,
      intervalMs: 1000,
      runProjectCycle: runner.run.bind(runner)
    });

    scheduler.start();
    expect(clock.timers.map((timer) => timer.delayMs)).toEqual([0]);
    await clock.runNext();
    await waitUntil(() => clock.timers.length === 1);
    expect(clock.timers[0]?.delayMs).toBe(1000);
    expect(getPiGuardianWatchdogStatus(db)?.last_seen_at).toBeTruthy();
    scheduler.stop();
  });

  test("throttles supervisor scans separately from the faster schedule tick", async () => {
    const db = await openFixtureDatabase();
    const wrapped = new SlowSupervisorDatabase(db);
    const runner = new FakePiCycleRunner();
    const clock = new FakeClock();
    const errors: unknown[] = [];
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
  });

  test("continues Guardian maintenance without launching project cycles while idle", async () => {
    const db = await openFixtureDatabase();
    const wrapped = new SlowSupervisorDatabase(db);
    const clock = new FakeClock();
    const errors: unknown[] = [];
    const runner = new FakePiCycleRunner();
    insertManagedProject(db, "enabled");
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
  });

  test("supports a one-time initial offset before returning to the normal interval", async () => {
    const db = await openFixtureDatabase();
    const clock = new FakeClock();
    const runner = new FakePiCycleRunner();
    const scheduler = createPiAgenticScheduler({
      clock,
      database: db,
      initialDelayMs: 15_000,
      intervalMs: 30_000,
      runProjectCycle: runner.run.bind(runner),
      runSupervisor: false
    });

    scheduler.start();
    expect(clock.timers.map((timer) => timer.delayMs)).toEqual([15_000]);
    await clock.runNext();
    await waitUntil(() => clock.timers.length === 1);
    expect(clock.timers.map((timer) => timer.delayMs)).toEqual([30_000]);
    scheduler.stop();
  });
}
