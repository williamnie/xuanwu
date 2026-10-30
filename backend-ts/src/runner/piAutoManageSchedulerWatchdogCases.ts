import { expect, test } from "bun:test";

import { runPiAutoManageCycle } from "./piAutoManageScheduler.ts";

import {
  FakePiCycleRunner,
  openFixtureDatabase,
  insertManagedProject,
  waitUntil
} from "./piAutoManageSchedulerTestFixtures.ts";

export function registerPiAutoManageSchedulerWatchdogCases() {
  test("skips reentrant cycles for the same project", async () => {
    const db = await openFixtureDatabase();
    const runner = new FakePiCycleRunner();
    let release!: () => void;
    runner.deferred = new Promise<void>((resolve) => { release = resolve; });
    insertManagedProject(db, "enabled");

    const first = runPiAutoManageCycle({ database: db, runProjectCycle: runner.run.bind(runner) });
    await waitUntil(() => runner.active === 1);
    const second = await runPiAutoManageCycle({ database: db, runProjectCycle: runner.run.bind(runner) });
    release();

    expect(await first).toEqual({ projects: 1, started: 1, skipped: 0 });
    expect(second).toEqual({ projects: 1, started: 0, skipped: 1 });
    expect(runner.calls).toEqual([{ projectId: "enabled" }]);
  });
}
