import { describe, expect, test } from "bun:test";
import { type RunnerDatabase } from "../../db/database.ts";
import {
  createPiNotificationIntent,
  getPiGuardianWatchdogStatus,
  listPiGuardianAlerts,
  listPiNotificationIntents,
  upsertPiGuardianWatchdogStatus
} from "../../db/repositories/pi.ts";
import { buildFeishuConnectorConfig } from "../../integrations/feishu/feishu.ts";
import { FeishuClientError } from "../../integrations/feishu/feishuClient.ts";
import { sendDirectFeishuGuardianAlert } from "../../integrations/feishu/feishuGuardianAlerts.ts";
import { runPiGuardianWatchdogOnce } from "./guardianWatchdog.ts";
import { useTestDatabase } from "../../testing/harness.ts";

import { openFixtureDatabase, NOW, STALE_MS, insertProject, failingProbe, feishuConfig, guardianDelivery, FakeGuardianFeishuSender, insertProjectPiSettings, insertStuckOutbox, insertSuppressedStuckOutbox, insertStaleNotificationIntent, insertUnroutableLifecycleIntent, insertOverdueRunGroup, insertFailedApprovalResolver, insertPendingGuardianInboxEvent, markAlertStatus, sideEffectCounts, countRows } from "./guardianWatchdogTestFixtures.ts";

export function registerRetriesUnacknowledgedSentUrgentAlertsWith() {
test("retries unacknowledged sent urgent alerts with backoff and max cap", async () => {
    const db = await openFixtureDatabase();
    const sender = new FakeGuardianFeishuSender([
      { messageId: "om_initial" },
      { messageId: "om_retry_1" },
      { messageId: "om_retry_2" },
      { messageId: "om_retry_3" },
      { messageId: "om_unexpected" }
    ]);
    insertProject(db, "demo");

    await runPiGuardianWatchdogOnce(db, {
      checks: [failingProbe()],
      delivery: guardianDelivery(db, sender),
      now: NOW,
      staleAfterMs: STALE_MS
    });
    await runPiGuardianWatchdogOnce(db, {
      checks: [failingProbe()],
      delivery: guardianDelivery(db, sender),
      now: new Date("2026-06-19T01:10:00Z"),
      staleAfterMs: STALE_MS
    });
    await runPiGuardianWatchdogOnce(db, {
      checks: [failingProbe()],
      delivery: guardianDelivery(db, sender),
      now: new Date("2026-06-19T01:15:00Z"),
      staleAfterMs: STALE_MS
    });
    await runPiGuardianWatchdogOnce(db, {
      checks: [failingProbe()],
      delivery: guardianDelivery(db, sender),
      now: new Date("2026-06-19T02:15:00Z"),
      staleAfterMs: STALE_MS
    });
    await runPiGuardianWatchdogOnce(db, {
      checks: [failingProbe()],
      delivery: guardianDelivery(db, sender),
      now: new Date("2026-06-19T06:15:00Z"),
      staleAfterMs: STALE_MS
    });
    await runPiGuardianWatchdogOnce(db, {
      checks: [failingProbe()],
      delivery: guardianDelivery(db, sender),
      now: new Date("2026-06-19T10:15:00Z"),
      staleAfterMs: STALE_MS
    });
    const alert = listPiGuardianAlerts(db, { projectId: "demo", status: "open" })[0];

    expect(sender.calls).toHaveLength(4);
    expect(alert).toMatchObject({
      direct_feishu_message_id: "om_retry_3",
      direct_feishu_state: "sent",
      next_retry_at: "",
      retry_count: 3,
      status: "open",
      ui_visible: 1
    });
  });

for (const status of ["acked", "suppressed"] as const) {
    test(`does not reopen or retry ${status} alerts for the same watchdog condition`, async () => {
      const db = await openFixtureDatabase();
      const sender = new FakeGuardianFeishuSender([{ messageId: "om_guardian_sent_1" }]);
      insertProject(db, "demo");
      await runPiGuardianWatchdogOnce(db, {
        checks: [failingProbe()],
        delivery: guardianDelivery(db, sender),
        now: NOW,
        staleAfterMs: STALE_MS
      });
      const firstAlert = listPiGuardianAlerts(db, { projectId: "demo", status: "open" })[0];
      if (!firstAlert) throw new Error("expected open alert");
      markAlertStatus(db, firstAlert.id, status);

      await runPiGuardianWatchdogOnce(db, {
        checks: [failingProbe()],
        delivery: guardianDelivery(db, sender),
        now: new Date("2026-06-19T01:15:00Z"),
        staleAfterMs: STALE_MS
      });

      expect(sender.calls).toHaveLength(1);
      expect(listPiGuardianAlerts(db, { projectId: "demo", status: "open" })).toHaveLength(0);
      expect(listPiGuardianAlerts(db, { projectId: "demo", status })).toHaveLength(1);
    });
  }

test("creates a new incident when the same watchdog condition recurs after recovery", async () => {
    const db = await openFixtureDatabase();
    const sender = new FakeGuardianFeishuSender([
      { messageId: "om_guardian_first" },
      { messageId: "om_guardian_recurrence" }
    ]);
    insertProject(db, "demo");
    await runPiGuardianWatchdogOnce(db, {
      checks: [failingProbe()], delivery: guardianDelivery(db, sender), now: NOW, staleAfterMs: STALE_MS
    });
    const first = listPiGuardianAlerts(db, { projectId: "demo", status: "open" })[0];
    if (!first) throw new Error("expected first alert");
    markAlertStatus(db, first.id, "resolved");

    await runPiGuardianWatchdogOnce(db, {
      checks: [failingProbe()], delivery: guardianDelivery(db, sender),
      now: new Date("2026-06-19T01:15:00Z"), staleAfterMs: STALE_MS
    });

    expect(sender.calls).toHaveLength(2);
    expect(listPiGuardianAlerts(db, { projectId: "demo", status: "resolved" })).toHaveLength(1);
    const recurrence = listPiGuardianAlerts(db, { projectId: "demo", status: "open" })[0];
    expect(recurrence).toMatchObject({ status: "open" });
    expect(recurrence?.id).not.toBe(first.id);
  });

test("writes PI runtime alert, refreshes liveness, and avoids PI/outbox side effects", async () => {
    const db = await openFixtureDatabase();
    insertProject(db, "demo");
    insertProjectPiSettings(db, "demo");
    db.sqlite.run("update pi_agents set enabled=0 where id='runner-default'");

    const result = await runPiGuardianWatchdogOnce(db, { now: NOW, staleAfterMs: STALE_MS });
    const alerts = listPiGuardianAlerts(db, { projectId: "demo", status: "open" });

    expect(result).toMatchObject({ alerts: 1, errors: 0 });
    expect(result.checks.map((check) => check.component).sort()).toEqual([
      "approval", "coordinator", "digest", "inbox", "outbox", "pi_runtime", "scheduler"
    ]);
    expect(result.checks.find((check) => check.component === "pi_runtime")).toMatchObject({
      alert_type: "pi_runtime_down",
      ok: false,
      project_id: "demo"
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      alert_type: "pi_runtime_down",
      project_id: "demo",
      status: "open",
      ui_visible: 1,
      watchdog_seen_at: "2026-06-19T01:00:00Z"
    });
    expect(getPiGuardianWatchdogStatus(db)).toMatchObject({
      last_error: "",
      last_seen_at: "2026-06-19T01:00:00Z",
      last_success_at: "2026-06-19T01:00:00Z"
    });
    expect(sideEffectCounts(db)).toEqual({
      conversations: 0,
      drafts: 0,
      intents: 0,
      outbox: 0
    });
  });

test("detects stuck outbox and refreshes the same open alert", async () => {
    const db = await openFixtureDatabase();
    insertStuckOutbox(db, "2026-06-19T00:00:00Z");

    const first = await runPiGuardianWatchdogOnce(db, { now: NOW, staleAfterMs: STALE_MS });
    const firstAlert = listPiGuardianAlerts(db, { alertType: "outbox_stalled", status: "open" })[0];
    const second = await runPiGuardianWatchdogOnce(db, {
      now: new Date("2026-06-19T01:05:00Z"),
      schedulerStaleAfterMs: 10 * 60_000,
      staleAfterMs: STALE_MS
    });
    const alerts = listPiGuardianAlerts(db, { alertType: "outbox_stalled", status: "open" });

    expect(first.checks.find((check) => check.component === "outbox")).toMatchObject({
      alert_type: "outbox_stalled",
      ok: false
    });
    expect(first.alerts).toBe(1);
    expect(second.alerts).toBe(1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].id).toBe(firstAlert?.id);
    expect(alerts[0].watchdog_seen_at).toBe("2026-06-19T01:05:00Z");
    expect(sideEffectCounts(db)).toEqual({
      conversations: 0,
      drafts: 0,
      intents: 0,
      outbox: 1
    });
  });

test("does not report an outbox row whose notification intent was suppressed", async () => {
    const db = await openFixtureDatabase();
    insertSuppressedStuckOutbox(db, "2026-06-19T00:00:00Z");

    const result = await runPiGuardianWatchdogOnce(db, { now: NOW, staleAfterMs: STALE_MS });

    expect(result.checks.find((check) => check.component === "outbox")).toMatchObject({ ok: true });
    expect(listPiGuardianAlerts(db, { alertType: "outbox_stalled", status: "open" })).toEqual([]);
    expect(sideEffectCounts(db).outbox).toBe(1);
  });
}
