import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createPiNotificationIntent, getPiNotificationIntent } from "../db/repositories/pi.ts";
import { queueReadyImDigestNotifications } from "./digestNotifications.ts";

const tempRoots: string[] = [];
const NOW = new Date("2026-09-29T00:00:00Z");

afterEach(async () => {
  for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("ready IM digest delivery", () => {
  test("passes twenty unroutable digests and does not rewrite failures during backoff", async () => {
    const db = await fixtureDatabase();
    try {
      for (let index = 0; index < 20; index += 1) seedDigest(db, index, false);
      seedDigest(db, 20, true);
      seedDigest(db, 21, true);

      expect(queueReadyImDigestNotifications(db, { now: NOW })).toEqual({
        failed: 20, queued: 2, scanned: 22, skipped: 0
      });
      expect(getPiNotificationIntent(db, "digest-000")).toMatchObject({
        error: "missing_im_target", flush_after_at: "2026-09-29T00:15:00.000Z", state: "ready"
      });
      expect(getPiNotificationIntent(db, "digest-020")?.state).toBe("agent_pending");
      const changes = totalChanges(db);
      expect(queueReadyImDigestNotifications(db, { now: new Date("2026-09-29T00:01:00Z") })).toEqual({
        failed: 0, queued: 0, scanned: 0, skipped: 0
      });
      expect(totalChanges(db)).toBe(changes);
      expect(queueReadyImDigestNotifications(db, { now: new Date("2026-09-29T00:15:00Z") }).failed).toBe(20);
      expect(countOutbox(db)).toBe(0);
    } finally { db.close(); }
  });

  test("bounds each scan and advances later records across ticks", async () => {
    const db = await fixtureDatabase();
    try {
      for (let index = 0; index < 120; index += 1) seedDigest(db, index, false);
      for (let index = 120; index < 141; index += 1) seedDigest(db, index, true);

      expect(queueReadyImDigestNotifications(db, { now: NOW })).toEqual({
        failed: 100, queued: 0, scanned: 100, skipped: 0
      });
      expect(queueReadyImDigestNotifications(db, { now: NOW })).toEqual({
        failed: 20, queued: 20, scanned: 40, skipped: 0
      });
      expect(queueReadyImDigestNotifications(db, { now: NOW })).toEqual({
        failed: 0, queued: 1, scanned: 1, skipped: 0
      });
    } finally { db.close(); }
  });

  test("excludes already linked records and respects a future eligibility time", async () => {
    const db = await fixtureDatabase();
    try {
      for (let index = 0; index < 20; index += 1) {
        seedDigest(db, index, true);
        db.sqlite.run("update pi_notification_intents set sent_outbox_id=1 where id=?", [digestID(index)]);
      }
      seedDigest(db, 20, true);
      db.sqlite.run("update pi_notification_intents set flush_after_at=? where id=?", [
        "2026-09-29T00:15:00Z", digestID(20)
      ]);
      expect(queueReadyImDigestNotifications(db, { now: NOW }).scanned).toBe(0);
      expect(queueReadyImDigestNotifications(db, { now: new Date("2026-09-29T00:15:00Z") })).toEqual({
        failed: 0, queued: 1, scanned: 1, skipped: 0
      });
    } finally { db.close(); }
  });
});

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-digest-delivery-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function seedDigest(db: RunnerDatabase, index: number, routable: boolean): void {
  createPiNotificationIntent(db, {
    id: digestID(index), idempotency_key: digestID(index), kind: "digest", state: "ready",
    run_group_id: digestID(index), flush_reason: "completed", flush_sequence: 1,
    payload_json: { total_count: 1 }, target_channel: "telegram", target_chat_id: routable ? "chat-1" : ""
  });
  db.sqlite.run("update pi_notification_intents set created_at=? where id=?", [
    "2026-09-28T00:00:00Z", digestID(index)
  ]);
}

function digestID(index: number): string { return `digest-${String(index).padStart(3, "0")}`; }
function totalChanges(db: RunnerDatabase): number {
  return db.sqlite.query<{ count: number }, []>("select total_changes() as count").get()!.count;
}
function countOutbox(db: RunnerDatabase): number {
  return db.sqlite.query<{ count: number }, []>("select count(*) as count from sync_outbox").get()!.count;
}
