import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../database.ts";
import { createCronTask } from "./cronTaskWrites.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("cron task schedule writes", () => {
  test("defaults natural language schedule timezone to Asia/Shanghai", async () => {
    const db = await openFixtureDatabase();
    try {
      const task = createCronTask(db, {
        action: "run_heartbeat",
        project_id: "demo",
        schedule_expr: "每天早上 9 点"
      });

      expect(task).toMatchObject({
        mode: "daily",
        schedule_expr: "每天早上 9 点",
        time_of_day: "09:00",
        timezone: "Asia/Shanghai"
      });
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-cron-writes-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}
