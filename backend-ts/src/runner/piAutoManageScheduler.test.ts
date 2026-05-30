import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createPiAutoManageScheduler, runPiAutoManageCycle } from "./piAutoManageScheduler.ts";

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

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met");
}
