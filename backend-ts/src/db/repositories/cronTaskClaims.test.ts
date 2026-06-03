import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../database.ts";
import { claimDueCronTasks } from "./cronTaskClaims.ts";

const tempRoots: string[] = [];
const NOW = new Date("2026-06-02T10:00:00Z");

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("cron due task claims", () => {
  test("claims only due active cron tasks", async () => {
    const db = await openFixtureDatabase();
    try {
      const dueActive = insertCronTask(db, "active", "2026-06-02T09:59:00.000Z");
      insertCronTask(db, "active", "2026-06-02T10:01:00.000Z");
      insertCronTask(db, "paused", "2026-06-02T09:59:00.000Z");
      insertCronTask(db, "done", "2026-06-02T09:59:00.000Z");

      const claimed = claimDueCronTasks(db, NOW);

      expect(claimed.map((task) => task.id)).toEqual([dueActive]);
      expect(claimed[0]?.status).toBe("active");
      expect(claimed[0]?.claim_token).not.toBe("");
      expect(claimedCronIDs(db)).toEqual([dueActive]);
    } finally {
      db.close();
    }
  });

  test("does not claim the same due cron task from another database connection", async () => {
    const root = await tempRoot();
    const stateDir = join(root, "state");
    const firstDb = await openDatabase({ stateDir });
    const secondDb = await openDatabase({ stateDir });
    try {
      const taskID = insertCronTask(firstDb, "active", "2026-06-02T09:59:00.000Z");

      const firstClaim = claimDueCronTasks(firstDb, NOW);
      const secondClaim = claimDueCronTasks(secondDb, NOW);

      expect(firstClaim.map((task) => task.id)).toEqual([taskID]);
      expect(secondClaim).toEqual([]);
      expect(claimedCronIDs(firstDb)).toEqual([taskID]);
    } finally {
      firstDb.close();
      secondDb.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await tempRoot();
  return openDatabase({ stateDir: join(root, "state") });
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-cron-claims-"));
  tempRoots.push(root);
  return root;
}

function insertCronTask(db: RunnerDatabase, status: string, nextRunAt: string): number {
  db.sqlite.run(
    `insert into cron_tasks
      (name, project_id, action, mode, time_of_day, next_run_at, status, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["Cron", "project-a", "sync_projects", "once", "", nextRunAt, status,
      "2026-06-02T09:00:00Z", "2026-06-02T09:00:00Z"]
  );
  return db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0;
}

function claimedCronIDs(db: RunnerDatabase): number[] {
  return db.sqlite.query<{ id: number }, []>(
    "select id from cron_tasks where claim_token<>'' order by id asc"
  ).all().map((row) => row.id);
}
