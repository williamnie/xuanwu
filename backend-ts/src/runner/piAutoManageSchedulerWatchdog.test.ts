import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listSyncOutbox } from "../db/repositories/imReplyOutbox.ts";
import {
  createPiNotificationIntent,
  getPiGuardianWatchdogStatus,
  listPiNotificationIntents,
  upsertPiGuardianAlert
} from "../db/repositories/pi.ts";
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

  test("sweeps missed intents after watchdog recovery and queues one digest", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      insertRecoveredOutboxAlert(db);
      createPiNotificationIntent(db, {
        conversation_id: "feishu-chat-oc_group-20260619",
        error: "outbox failed during outage",
        id: "missed-failed-intent",
        idempotency_key: "missed-failed-intent",
        issue_id: 492,
        kind: "issue_failed",
        project_id: "demo",
        state: "failed",
        target_channel: "feishu"
      });
      db.sqlite.run("update pi_notification_intents set created_at=?, updated_at=? where id=?", [
        "2026-06-19T00:02:00Z", "2026-06-19T00:02:00Z", "missed-failed-intent"
      ]);

      const result = await runScheduleLayerCycle({
        database: db,
        runProjectCycle: async () => ({}),
        watchdogNow: new Date("2026-06-19T00:10:00Z"),
        watchdogStaleAfterMs: 60_000
      });
      const digests = listPiNotificationIntents(db, { kind: "digest" });

      expect(result.missedIntentSweep).toMatchObject({ summaries: 1, windows: 1 });
      expect(result.digestNotifications).toMatchObject({ queued: 1 });
      expect(digests).toMatchObject([{ flush_reason: "recovery", state: "sent" }]);
      expect(listSyncOutbox(db, { source: "feishu" })).toHaveLength(1);
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

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, created_at, updated_at)
     values (?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "2026-06-19T00:00:00Z", "2026-06-19T00:00:00Z"]
  );
}

function insertRecoveredOutboxAlert(db: RunnerDatabase): void {
  const alert = upsertPiGuardianAlert(db, {
    alert_type: "outbox_stalled",
    evidence_json: { oldest_created_at: "2026-06-19T00:00:00Z" },
    message: "outbox stalled during outage",
    project_id: "demo",
    watchdog_seen_at: "2026-06-19T00:05:00Z"
  });
  db.sqlite.run("update pi_guardian_alerts set created_at=?, updated_at=? where id=?", [
    "2026-06-19T00:05:00Z", "2026-06-19T00:05:00Z", alert.id
  ]);
}
