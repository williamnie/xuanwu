import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createPiDelegation } from "../db/repositories/pi.ts";
import { runPiHeartbeatOnce } from "./heartbeatOrchestrator.ts";
import { collectProjectHeartbeatSignals } from "./heartbeatSignals.ts";

const NOW = new Date("2026-06-02T10:00:00Z");
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI heartbeat concurrency", () => {
  test("skips a concurrent heartbeat for the same project", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "project-a");
      const gate = deferred<void>();
      const firstRun = runPiHeartbeatOnce({
        collectSignals: async (input) => {
          gate.started();
          await gate.release;
          return collectProjectHeartbeatSignals(input.database, input.projectID, input.now);
        },
        database: db,
        kind: "project",
        now: NOW,
        projectID: "project-a"
      });
      await gate.ready;

      const secondRun = await runPiHeartbeatOnce({ database: db, kind: "cron", now: NOW, projectID: "project-a" });
      gate.finish();

      expect(await firstRun).toMatchObject({ project_id: "project-a", status: "completed" });
      expect(secondRun).toMatchObject({ project_id: "project-a", skip_reason: "heartbeat already running", status: "skipped" });
      expect(runningHeartbeatCount(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  test("skips a concurrent heartbeat for the same delegation", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "project-a");
      const delegation = createPiDelegation(db, {
        id: "delegation-a",
        project_id: "project-a",
        title: "Watch project"
      });
      const gate = deferred<void>();
      const firstRun = runPiHeartbeatOnce({
        collectSignals: async (input) => {
          gate.started();
          await gate.release;
          return collectProjectHeartbeatSignals(input.database, input.projectID, input.now);
        },
        database: db,
        delegation,
        kind: "delegation",
        now: NOW,
        projectID: "project-a"
      });
      await gate.ready;

      const secondRun = await runPiHeartbeatOnce({
        database: db,
        delegation,
        kind: "delegation",
        now: NOW,
        projectID: "project-a"
      });
      gate.finish();

      expect(await firstRun).toMatchObject({ delegation_id: "delegation-a", status: "completed" });
      expect(secondRun).toMatchObject({ delegation_id: "delegation-a", skip_reason: "heartbeat already running", status: "skipped" });
      expect(runningHeartbeatCount(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  test("skips delegation heartbeat while the project heartbeat is running", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "project-a");
      const delegation = createPiDelegation(db, { id: "delegation-a", project_id: "project-a" });
      const gate = deferred<void>();
      const firstRun = runPiHeartbeatOnce({
        collectSignals: async (input) => {
          gate.started();
          await gate.release;
          return collectProjectHeartbeatSignals(input.database, input.projectID, input.now);
        },
        database: db,
        kind: "project",
        now: NOW,
        projectID: "project-a"
      });
      await gate.ready;

      const secondRun = await runPiHeartbeatOnce({ database: db, delegation, kind: "delegation", now: NOW, projectID: "project-a" });
      gate.finish();

      expect(await firstRun).toMatchObject({ project_id: "project-a", status: "completed" });
      expect(secondRun).toMatchObject({ delegation_id: "delegation-a", skip_reason: "heartbeat already running", status: "skipped" });
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-heartbeat-concurrency-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function deferred<T>() {
  let started!: () => void;
  let finish!: (value: T) => void;
  return {
    ready: new Promise<void>((resolve) => { started = resolve; }),
    release: new Promise<T>((resolve) => { finish = resolve; }),
    finish: (value?: T) => finish(value as T),
    started
  };
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, auto_run, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, 1, 1, "2026-06-02T09:00:00Z", "2026-06-02T09:00:00Z"]
  );
}

function runningHeartbeatCount(db: RunnerDatabase): number {
  return db.sqlite.query<{ count: number }, []>(
    "select count(*) as count from pi_heartbeat_runs where status='running'"
  ).get()?.count ?? 0;
}
