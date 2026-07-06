import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import {
  claimDuePiAutomations,
  type ClaimedPiAutomation
} from "../db/repositories/piAutomationScheduler.ts";
import { createPiAutomation, getPiAutomation, listRunnablePiAutomations } from "../db/repositories/piAutomations.ts";
import { runDuePiAutomations } from "./piAutomationScheduler.ts";

const tempRoots: string[] = [];
const NOW = new Date("2026-06-02T10:00:00Z");

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI automation scheduler", () => {
  test("locks one scheduled automation while running and records cursor success", async () => {
    const root = await tempRoot();
    const firstDb = await openDatabase({ stateDir: join(root, "state") });
    const secondDb = await openDatabase({ stateDir: join(root, "state") });
    try {
      const automation = insertAutomation(firstDb, { nextRunAt: "2026-06-02T09:59:00Z" });
      let duplicate = { executed: 0, failed: 0, scanned: 0, skipped: 0 };

      const result = await runDuePiAutomations({
        database: firstDb,
        now: NOW,
        executeAutomation: async () => {
          duplicate = await runDuePiAutomations({ database: secondDb, now: NOW });
          return { detail: "ok", lastSuccessfulCursor: "cursor-2", processedWatermark: "wm-2" };
        }
      });

      expect(result).toEqual({ executed: 1, failed: 0, scanned: 1, skipped: 0 });
      expect(duplicate).toEqual({ executed: 0, failed: 0, scanned: 0, skipped: 0 });
      expect(getPiAutomation(firstDb, automation.id)).toMatchObject({
        failed_cursor: "",
        last_status: "success",
        last_successful_cursor: "cursor-2",
        lock_token: "",
        next_run_at: "2026-06-02T10:05:00.000Z",
        processed_watermark: "wm-2",
        retry_count: 0,
        run_count: 1
      });
    } finally {
      firstDb.close();
      secondDb.close();
    }
  });

  test("backs off after failure without advancing successful cursor or watermark", async () => {
    const db = await openFixtureDatabase();
    try {
      const automation = insertAutomation(db, { nextRunAt: "2026-06-02T09:59:00Z" });
      seedCursor(db, automation.id, "cursor-ok", "wm-ok");
      const error = Object.assign(new Error("source sync failed"), { failed_cursor: "cursor-bad" });

      const failed = await runDuePiAutomations({
        database: db,
        now: NOW,
        executeAutomation: async () => { throw error; }
      });
      expect(getPiAutomation(db, automation.id)).toMatchObject({
        failed_cursor: "cursor-bad",
        last_successful_cursor: "cursor-ok",
        next_run_at: "2026-06-02T10:01:00.000Z",
        processed_watermark: "wm-ok",
        retry_count: 1
      });
      const earlyRetry = await runDuePiAutomations({ database: db, now: new Date("2026-06-02T10:00:30Z") });
      const retried = await runDuePiAutomations({
        database: db,
        now: new Date("2026-06-02T10:01:00Z"),
        executeAutomation: async () => ({ detail: "retry ok", lastSuccessfulCursor: "cursor-next" })
      });

      expect(failed).toEqual({ executed: 0, failed: 1, scanned: 1, skipped: 0 });
      expect(earlyRetry.scanned).toBe(0);
      expect(retried.executed).toBe(1);
      expect(getPiAutomation(db, automation.id)).toMatchObject({
        failed_cursor: "",
        last_status: "success",
        last_successful_cursor: "cursor-next",
        processed_watermark: "wm-ok",
        retry_count: 0,
        run_count: 2
      });
    } finally {
      db.close();
    }
  });

  test("keeps unfinished restart claims locked until timeout then schedules backoff", async () => {
    const root = await tempRoot();
    const firstDb = await openDatabase({ stateDir: join(root, "state") });
    const restartedDb = await openDatabase({ stateDir: join(root, "state") });
    try {
      const automation = insertAutomation(firstDb, {
        nextRunAt: "2026-06-02T09:59:00Z",
        runTimeoutMs: 60_000
      });

      expect(claimDuePiAutomations(firstDb, NOW).map((item) => item.id)).toEqual([automation.id]);
      expect(claimDuePiAutomations(restartedDb, new Date("2026-06-02T10:00:30Z"))).toEqual([]);
      expect(claimDuePiAutomations(restartedDb, new Date("2026-06-02T10:01:00Z"))).toEqual([]);
      expect(getPiAutomation(restartedDb, automation.id)).toMatchObject({
        error: "automation run timeout",
        last_status: "error",
        lock_token: "",
        next_run_at: "2026-06-02T10:02:00.000Z",
        retry_count: 1
      });
      expect(claimDuePiAutomations(restartedDb, new Date("2026-06-02T10:02:00Z"))
        .map((item: ClaimedPiAutomation) => item.id)).toEqual([automation.id]);
    } finally {
      firstDb.close();
      restartedDb.close();
    }
  });

  test("scheduler ignores manual and disabled cron automations", async () => {
    const db = await openFixtureDatabase();
    try {
      const manual = insertAutomation(db, { nextRunAt: "2026-06-02T09:59:00Z", triggerType: "manual" });
      insertAutomation(db, { enabled: false, nextRunAt: "2026-06-02T09:59:00Z" });

      const result = await runDuePiAutomations({ database: db, now: NOW });

      expect(result).toEqual({ executed: 0, failed: 0, scanned: 0, skipped: 0 });
      expect(listRunnablePiAutomations(db, "manual").map((item) => item.id)).toEqual([manual.id]);
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
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-automation-scheduler-"));
  tempRoots.push(root);
  return root;
}

function insertAutomation(db: RunnerDatabase, input: {
  enabled?: boolean; nextRunAt: string; runTimeoutMs?: number; triggerType?: "manual" | "schedule";
}) {
  return createPiAutomation(db, {
    enabled: input.enabled,
    name: `${input.triggerType ?? "schedule"} automation`,
    next_run_at: input.nextRunAt,
    retry_backoff_seconds: 60,
    run_timeout_ms: input.runTimeoutMs ?? 300_000,
    steps: [{ cursor: "cursor-1", idempotency_key: "step-1", type: "source_sync", watermark: "wm-1" }],
    trigger: { every: "5m", type: input.triggerType ?? "schedule" }
  }, new Date("2026-06-02T09:00:00Z"));
}

function seedCursor(db: RunnerDatabase, id: number, cursor: string, watermark: string): void {
  db.sqlite.run(
    "update pi_automations set last_successful_cursor=?, processed_watermark=? where id=?",
    [cursor, watermark, id]
  );
}
