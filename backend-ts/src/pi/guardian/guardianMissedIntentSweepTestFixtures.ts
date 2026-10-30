import { describe, expect, test } from "bun:test";
import { type RunnerDatabase } from "../../db/database.ts";
import { listSyncOutbox } from "../../db/repositories/imReplyOutbox.ts";
import {
  createPiNotificationIntent,
  getPiGuardianAlert,
  listPiGuardianAlerts,
  listPiGuardianDecisions,
  listPiNotificationIntents,
  upsertPiGuardianAlert
} from "../../db/repositories/pi.ts";
import { buildFeishuConnectorConfig } from "../../integrations/feishu/feishu.ts";
import type { FeishuTextMessageInput, FeishuTextMessageResult } from "../../integrations/feishu/feishuClient.ts";
import { sendDirectFeishuGuardianAlert } from "../../integrations/feishu/feishuGuardianAlerts.ts";
import { sendMissedDigestPendingFallback } from "./guardianMissedDigestFallback.ts";
import { runGuardianMissedIntentSweepOnce } from "./guardianMissedIntentSweep.ts";
import { resolveRecoveredAlerts } from "./guardianWatchdogMaintenance.ts";
import type { PiGuardianWatchdogComponent } from "./guardianWatchdog.ts";
import type { PiGuardianWatchdogSummary } from "./guardianWatchdog.ts";
import { useTestDatabase } from "../../testing/harness.ts";

export const openFixtureDatabase = useTestDatabase();

export const NOW = "2026-06-19T00:10:00Z";

export function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, created_at, updated_at)
     values (?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "2026-06-19T00:00:00Z", "2026-06-19T00:00:00Z"]
  );
}

export function insertOutageAlert(db: RunnerDatabase, alertType: string): void {
  const alert = upsertPiGuardianAlert(db, {
    alert_type: alertType,
    evidence_json: { oldest_created_at: "2026-06-19T00:00:00Z" },
    message: `${alertType} during outage`,
    project_id: "demo",
    watchdog_seen_at: "2026-06-19T00:05:00Z"
  });
  db.sqlite.run("update pi_guardian_alerts set created_at=?, updated_at=? where id=?", [
    "2026-06-19T00:05:00Z", "2026-06-19T00:05:00Z", alert.id
  ]);
}

export function insertMissedIntent(
  db: RunnerDatabase,
  id: string,
  input: { flushAfter?: string; issueID: number; kind: string; state: string }
): void {
  createPiNotificationIntent(db, {
    conversation_id: "feishu-chat-oc_group-20260619",
    error: input.state === "failed" ? "delivery failed" : "",
    flush_after_at: input.flushAfter,
    id,
    idempotency_key: id,
    issue_id: input.issueID,
    kind: input.kind,
    project_id: "demo",
    state: input.state,
    summary: `${input.kind} missed`,
    target_channel: "feishu"
  });
  db.sqlite.run("update pi_notification_intents set created_at=?, updated_at=? where id=?", [
    "2026-06-19T00:02:00Z", "2026-06-19T00:02:00Z", id
  ]);
}

export function recoveryDigests(db: RunnerDatabase) {
  return listPiNotificationIntents(db, { kind: "digest" })
    .filter((intent) => intent.flush_reason === "recovery");
}

export function recoveredWatchdog(component: PiGuardianWatchdogComponent): PiGuardianWatchdogSummary {
  return {
    alerts: 0,
    checks: [{ component, ok: true }],
    errors: 0,
    scanned: 1
  };
}

export function unavailableDigestWatchdog(): PiGuardianWatchdogSummary {
  return {
    alerts: 0,
    checks: [
      { component: "outbox", ok: true },
      { component: "digest", ok: false }
    ],
    errors: 0,
    scanned: 2
  };
}

export function defaultFeishuConfig() {
  return buildFeishuConnectorConfig({
    feishuAllowedChatIds: "oc_default",
    feishuAppId: "cli_app_id",
    feishuAppSecret: "app-secret-value",
    feishuDefaultChatId: "oc_default"
  });
}

export function guardianDelivery(db: RunnerDatabase, sender: FakeGuardianSender, now: Date) {
  return {
    connectorID: "feishu",
    send: (alert: Parameters<typeof sendDirectFeishuGuardianAlert>[1], options: {
      formatText?: (value: Parameters<typeof sendDirectFeishuGuardianAlert>[1]) => string;
      now?: Date;
    } = {}) => sendDirectFeishuGuardianAlert(db, alert, {
      config: defaultFeishuConfig(),
      formatText: options.formatText,
      now: options.now ?? now,
      sender
    })
  };
}

export class FakeGuardianSender {
  calls: FeishuTextMessageInput[] = [];

  constructor(private readonly outcomes: Array<FeishuTextMessageResult | Error>) {}

  async sendTextMessage(input: FeishuTextMessageInput): Promise<FeishuTextMessageResult> {
    this.calls.push(input);
    const next = this.outcomes.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("unexpected fake missed digest Feishu send");
    return next;
  }
}
