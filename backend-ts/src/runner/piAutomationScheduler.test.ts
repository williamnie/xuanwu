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
import { createExternalEvent } from "../db/repositories/externalEvents.ts";
import { listContextBundles } from "../db/repositories/contextBundles.ts";
import { listAttentionInboxItems, listIntakeRuns } from "../db/repositories/intakeRuns.ts";
import { listActionProposals, listPiActions } from "../db/repositories/pi.ts";
import { DEFAULT_DOMAIN_SKILL_ID } from "../skills/builtinDomainProposal.ts";
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

  test("runs due continuous automation through context intake and domain proposal", async () => {
    const db = await openFixtureDatabase();
    try {
      seedRawEvent(db, "fixture-im", "m1", "登录页 500 了，麻烦创建 issue");
      const automation = insertAutomation(db, {
        nextRunAt: "2026-06-02T09:59:00Z",
        source: "fixture-im",
        triggerType: "continuous"
      });

      const result = await runDuePiAutomations({ database: db, now: NOW });

      expect(result).toEqual({ executed: 1, failed: 0, scanned: 1, skipped: 0 });
      expect(getPiAutomation(db, automation.id)).toMatchObject({
        error: "",
        last_status: "success",
        next_run_at: "2026-06-02T10:05:00.000Z",
        retry_count: 0,
        run_count: 1
      });
      expect(listContextBundles(db, "fixture-im")).toMatchObject([{
        created_by: "automation",
        source: "fixture-im",
        trigger: "continuous"
      }]);
      expect(listIntakeRuns(db)).toMatchObject([{ status: "succeeded" }]);
      expect(listAttentionInboxItems(db, { source: "fixture-im" })).toMatchObject([{
        primary_intent: "bug_report",
        status: "proposal_created"
      }]);
      expect(listPiActions(db).filter((action) => action.action_type === "attention_inbox.domain_skill")).toHaveLength(1);
      expect(listActionProposals(db)).toMatchObject([{ status: "proposed" }]);
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
  enabled?: boolean; nextRunAt: string; runTimeoutMs?: number; source?: string; triggerType?: "manual" | "schedule" | "continuous";
}) {
  return createPiAutomation(db, {
    enabled: input.enabled,
    name: `${input.triggerType ?? "schedule"} automation`,
    next_run_at: input.nextRunAt,
    retry_backoff_seconds: 60,
    run_timeout_ms: input.runTimeoutMs ?? 300_000,
    filters: input.source ? [{ source: input.source }] : [],
    mode: "propose",
    source_policy: input.source ? { action_mode: "propose_actions", intake_mode: "continuous_llm_triage", profile: "custom" } : {},
    steps: [
      { cursor: "cursor-1", idempotency_key: "step-1", type: "source_sync", watermark: "wm-1" },
      { cursor: "cursor-1", idempotency_key: "step-2", type: "context_bundle", watermark: "wm-1" },
      { cursor: "cursor-1", idempotency_key: "step-3", skill_id: "fixture-intake", type: "intake", watermark: "wm-1" },
      { cursor: "cursor-1", idempotency_key: "step-4", skill_id: DEFAULT_DOMAIN_SKILL_ID, type: "domain_skill", watermark: "wm-1" }
    ],
    trigger: { every: "5m", type: input.triggerType ?? "schedule" }
  }, new Date("2026-06-02T09:00:00Z"));
}

function seedCursor(db: RunnerDatabase, id: number, cursor: string, watermark: string): void {
  db.sqlite.run(
    "update pi_automations set last_successful_cursor=?, processed_watermark=? where id=?",
    [cursor, watermark, id]
  );
}

function seedRawEvent(db: RunnerDatabase, source: string, externalID: string, content: string): void {
  createExternalEvent(db, {
    actor: "alice",
    content,
    external_id: externalID,
    normalized_message: { message_id: externalID, thread_id: "thread-a" },
    occurred_at: "2026-06-02T09:58:00Z",
    provider: source,
    raw_json: { text: content },
    received_at: "2026-06-02T09:58:01Z",
    source
  });
}
