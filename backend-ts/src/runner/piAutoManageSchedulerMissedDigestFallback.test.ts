import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig } from "../config/env.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listSyncOutbox } from "../db/repositories/imReplyOutbox.ts";
import {
  createPiNotificationIntent,
  getPiGuardianAlert,
  upsertPiGuardianAlert
} from "../db/repositories/pi.ts";
import type { FeishuTextMessageInput, FeishuTextMessageResult } from "../integrations/feishuClient.ts";
import { runScheduleLayerCycle } from "./piAutoManageScheduler.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI auto-manage missed digest handling", () => {
  test("keeps recoverable digest and outbox incidents inside PI", async () => {
    const db = await openFixtureDatabase();
    const sender = new FakeGuardianSender([
      { messageId: "om_current_outbox" },
      { messageId: "om_missed_digest" }
    ]);
    try {
      insertProject(db, "demo");
      insertRecoveredCoordinatorAlert(db);
      insertStuckOutbox(db);
      insertMissedIntent(db);

      const result = await runScheduleLayerCycle({
        config: feishuConfig(),
        database: db,
        guardianDirectFeishuSender: sender,
        runProjectCycle: async () => ({}),
        watchdogNow: new Date("2026-06-19T00:10:00Z"),
        watchdogStaleAfterMs: 60_000
      });
      const alert = getPiGuardianAlert(db, result.missedIntentSweep.pendingAlertIds[0] ?? "");

      expect(result.missedIntentSweep).toMatchObject({ pending: 1, skipped: 1, summaries: 0, windows: 1 });
      expect(result.digestNotifications).toMatchObject({ queued: 0, scanned: 0 });
      expect(sender.calls).toHaveLength(0);
      expect(alert).toMatchObject({
        direct_feishu_message_id: "",
        direct_feishu_state: "not_attempted",
        next_retry_at: "",
        status: "open",
        ui_visible: 1
      });
      expect(listSyncOutbox(db, { source: "feishu" })).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-missed-digest-fallback-"));
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

function insertRecoveredCoordinatorAlert(db: RunnerDatabase): void {
  const alert = upsertPiGuardianAlert(db, {
    alert_type: "coordinator_stalled",
    evidence_json: { oldest_created_at: "2026-06-19T00:00:00Z" },
    message: "coordinator stalled during outage",
    project_id: "demo",
    watchdog_seen_at: "2026-06-19T00:05:00Z"
  });
  db.sqlite.run("update pi_guardian_alerts set created_at=?, updated_at=? where id=?", [
    "2026-06-19T00:05:00Z", "2026-06-19T00:05:00Z", alert.id
  ]);
}

function insertStuckOutbox(db: RunnerDatabase): void {
  db.sqlite.run(
    `insert into sync_outbox (source, reply_draft_id, content, status, created_at, updated_at)
     values ('feishu', 101, 'stuck message', 'pending', ?, ?)`,
    ["2026-06-19T00:00:00Z", "2026-06-19T00:00:00Z"]
  );
}

function insertMissedIntent(db: RunnerDatabase): void {
  createPiNotificationIntent(db, {
    error: "coordinator failed during outage",
    id: "missed-pending-intent",
    idempotency_key: "missed-pending-intent",
    issue_id: 530,
    kind: "issue_failed",
    project_id: "demo",
    state: "failed",
    target_channel: "feishu"
  });
  db.sqlite.run("update pi_notification_intents set created_at=?, updated_at=? where id=?", [
    "2026-06-19T00:02:00Z", "2026-06-19T00:02:00Z", "missed-pending-intent"
  ]);
}

function feishuConfig() {
  return buildConfig({
    feishuAllowedChatIds: "oc_default",
    feishuAppId: "cli_app_id",
    feishuAppSecret: "app-secret-value",
    feishuDefaultChatId: "oc_default"
  });
}

class FakeGuardianSender {
  calls: FeishuTextMessageInput[] = [];

  constructor(private readonly outcomes: Array<FeishuTextMessageResult | Error>) {}

  async sendTextMessage(input: FeishuTextMessageInput): Promise<FeishuTextMessageResult> {
    this.calls.push(input);
    const next = this.outcomes.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("unexpected fake scheduler Feishu send");
    return next;
  }
}
