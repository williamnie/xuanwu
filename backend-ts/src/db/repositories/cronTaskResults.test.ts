import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../database.ts";
import { listCronTasks } from "./cronTasks.ts";
import { recordCronTaskError, recordCronTaskSuccess } from "./cronTaskResults.ts";

const tempRoots: string[] = [];
const NOW = new Date("2026-06-02T10:00:00Z");

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("cron task result repository", () => {
  test("marks successful once cron task done and clears next run", async () => {
    const db = await openFixtureDatabase();
    try {
      insertCronTask(db, { mode: "once", nextRunAt: "2026-06-02T09:59:00.000Z" });

      recordCronTaskSuccess(db, { now: NOW, result: "enqueued 1 issue(s)", task: onlyCronTask(db) });

      expect(cronRow(db)).toMatchObject({
        error: "",
        last_result: "enqueued 1 issue(s)",
        last_run_at: "2026-06-02T10:00:00.000Z",
        last_status: "success",
        next_run_at: "",
        run_count: 1,
        status: "done"
      });
    } finally {
      db.close();
    }
  });

  test("advances successful daily cron task to the next run", async () => {
    const db = await openFixtureDatabase();
    try {
      insertCronTask(db, {
        mode: "daily",
        nextRunAt: "2026-06-02T09:59:00.000Z",
        timeOfDay: "18:30"
      });

      recordCronTaskSuccess(db, { now: NOW, result: "ran PI cycle", task: onlyCronTask(db) });

      expect(cronRow(db)).toMatchObject({
        last_result: "ran PI cycle",
        last_status: "success",
        next_run_at: "2026-06-03T18:30:00.000Z",
        status: "active"
      });
    } finally {
      db.close();
    }
  });

  test("records cron task error and advances recurring task", async () => {
    const db = await openFixtureDatabase();
    try {
      insertCronTask(db, {
        mode: "daily",
        nextRunAt: "2026-06-02T09:59:00.000Z",
        timeOfDay: "18:30"
      });

      recordCronTaskError(db, { now: NOW, result: "cycle boom", task: onlyCronTask(db) });

      expect(cronRow(db)).toMatchObject({
        error: "cycle boom",
        last_result: "cycle boom",
        last_status: "error",
        next_run_at: "2026-06-03T18:30:00.000Z",
        run_count: 1,
        status: "active"
      });
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await tempRoot();
  return openDatabase({ stateDir: join(root, "state") });
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-cron-results-"));
  tempRoots.push(root); return root;
}

function insertCronTask(db: RunnerDatabase, input: { mode: string; nextRunAt: string; timeOfDay?: string }): number {
  db.sqlite.run(
    `insert into cron_tasks
      (name, project_id, action, mode, time_of_day, next_run_at, status, claim_token,
        claim_started_at, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["Cron", "project-a", "run_pi_cycle", input.mode, input.timeOfDay ?? "", input.nextRunAt,
      "active", "claim-token", "2026-06-02T09:59:30.000Z", "2026-06-02T09:00:00Z",
      "2026-06-02T09:00:00Z"]
  );
  return db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0;
}

function onlyCronTask(db: RunnerDatabase) {
  const task = listCronTasks(db)[0];
  if (!task) throw new Error("cron task missing");
  return task;
}

function cronRow(db: RunnerDatabase) { return db.sqlite.query<Record<string, unknown>, []>("select * from cron_tasks limit 1").get() ?? {}; }
