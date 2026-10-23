import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunnerDatabase } from "../db/database.ts";
import { listSyncOutbox } from "../db/repositories/imReplyOutbox.ts";
import {
  createPiNotificationIntent,
  getPiGuardianWatchdogStatus,
  listPiGuardianAlerts,
  listPiNotificationIntents,
  upsertPiGuardianAlert
} from "../db/repositories/pi.ts";
import { runScheduleLayerCycle } from "./piAutoManageScheduler.ts";
import { useTestDatabase } from "../testing/harness.ts";

const openFixtureDatabase = useTestDatabase();

describe("PI auto-manage scheduler watchdog integration", () => {
  test("runs Guardian watchdog during schedule layer cycles", async () => {
    const db = await openFixtureDatabase();
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
  });

  test("sweeps missed intents after watchdog recovery and queues one digest", async () => {
    const db = await openFixtureDatabase();
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
      target_channel: "feishu",
      target_chat_id: "oc_group"
    });
    db.sqlite.run("update pi_notification_intents set created_at=?, updated_at=? where id=?", [
      "2026-06-19T00:02:00Z", "2026-06-19T00:02:00Z", "missed-failed-intent"
    ]);

    const result = await runScheduleLayerCycle({
      agentCommunicationDecider: async () => ({
        decision: "send",
        message: "Stone 已整理恢复摘要，请查看。",
        rationale: "recovery digest"
      }),
      database: db,
      runProjectCycle: async () => ({}),
      watchdogNow: new Date("2026-06-19T00:10:00Z"),
      watchdogStaleAfterMs: 60_000
    });
    const digests = listPiNotificationIntents(db, { kind: "digest" });

    expect(result.missedIntentSweep).toMatchObject({ summaries: 1, windows: 1 });
    expect(result.digestNotifications).toMatchObject({ queued: 1 });
    expect(digests).toMatchObject([{ flush_reason: "recovery", state: "sent" }]);
    expect(listPiGuardianAlerts(db, { alertType: "outbox_stalled", status: "open" })).toHaveLength(0);
    expect(listPiGuardianAlerts(db, { alertType: "outbox_stalled", status: "resolved" })).toMatchObject([
      expect.objectContaining({ message: "outbox recovered", watchdog_seen_at: "2026-06-19T00:10:00Z" })
    ]);
    expect(listSyncOutbox(db, { source: "feishu" })).toHaveLength(1);
  });

});

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
