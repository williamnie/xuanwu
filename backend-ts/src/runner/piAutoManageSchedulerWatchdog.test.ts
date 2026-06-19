import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getPiGuardianWatchdogStatus } from "../db/repositories/pi.ts";
import { runScheduleLayerCycle } from "./piAutoManageScheduler.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI auto-manage scheduler watchdog integration", () => {
  test("runs Guardian watchdog during schedule layer cycles", async () => {
    const db = await openFixtureDatabase();
    try {
      const result = await runScheduleLayerCycle({
        database: db,
        runProjectCycle: async () => ({}),
        watchdogNow: new Date("2026-06-19T01:00:00Z")
      });

      expect(result.watchdog).toMatchObject({ errors: 0 });
      expect(getPiGuardianWatchdogStatus(db)).toMatchObject({
        last_seen_at: "2026-06-19T01:00:00Z",
        last_success_at: "2026-06-19T01:00:00Z"
      });
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-watchdog-scheduler-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}
