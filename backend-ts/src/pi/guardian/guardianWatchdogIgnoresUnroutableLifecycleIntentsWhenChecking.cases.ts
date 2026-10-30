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

export function registerIgnoresUnroutableLifecycleIntentsWhenChecking() {
test("ignores unroutable lifecycle intents when checking coordinator stalls", async () => {
    const db = await openFixtureDatabase();
    insertProject(db, "demo");
    insertUnroutableLifecycleIntent(db, "intent-start", 501, "issue_start");
    insertUnroutableLifecycleIntent(db, "intent-done", 502, "issue_done");

    const result = await runPiGuardianWatchdogOnce(db, {
      now: NOW,
      staleAfterMs: STALE_MS
    });
    const coordinator = result.checks.find((check) => check.component === "coordinator");

    expect(coordinator).toMatchObject({ ok: true });
    expect(listPiGuardianAlerts(db, { alertType: "coordinator_stalled", status: "open" })).toHaveLength(0);
    expect(listPiNotificationIntents(db, { projectId: "demo" })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        decision: "suppress",
        error: "missing_feishu_link",
        id: "intent-start",
        state: "suppressed"
      }),
      expect.objectContaining({
        decision: "suppress",
        error: "missing_feishu_link",
        id: "intent-done",
        state: "suppressed"
      })
    ]));
  });

test("keeps recovered coordinator alert open for the scheduler missed-intent sweep", async () => {
    const db = await openFixtureDatabase();
    insertProject(db, "demo");
    insertStaleNotificationIntent(db);
    await runPiGuardianWatchdogOnce(db, { now: NOW, staleAfterMs: STALE_MS });
    const alert = listPiGuardianAlerts(db, { alertType: "coordinator_stalled", status: "open" })[0];
    if (!alert) throw new Error("expected coordinator alert");
    db.sqlite.run("update pi_notification_intents set state='suppressed', updated_at=? where id='intent-stale'", [
      "2026-06-19T01:01:00Z"
    ]);

    const result = await runPiGuardianWatchdogOnce(db, {
      now: new Date("2026-06-19T01:05:00Z"),
      staleAfterMs: STALE_MS
    });

    expect(result.checks.find((check) => check.component === "coordinator")).toMatchObject({ ok: true });
    expect(listPiGuardianAlerts(db, { alertType: "coordinator_stalled", status: "open" })).toMatchObject([
      expect.objectContaining({
        id: alert.id,
        message: "coordinator stalled: 1 stale item(s)",
        status: "open",
        watchdog_seen_at: "2026-06-19T01:00:00Z"
      })
    ]);
    expect(listPiGuardianAlerts(db, { alertType: "coordinator_stalled", status: "resolved" })).toHaveLength(0);
  });

test("detects coordinator digest approval scheduler and inbox issues", async () => {
    const db = await openFixtureDatabase();
    insertStaleNotificationIntent(db);
    insertOverdueRunGroup(db);
    insertFailedApprovalResolver(db);
    insertPendingGuardianInboxEvent(db);
    upsertPiGuardianWatchdogStatus(db, {
      last_seen_at: "2026-06-19T00:00:00Z",
      last_success_at: "2026-06-19T00:00:00Z"
    });

    const result = await runPiGuardianWatchdogOnce(db, {
      now: NOW,
      schedulerStaleAfterMs: STALE_MS,
      staleAfterMs: STALE_MS
    });
    const alertTypes = listPiGuardianAlerts(db, { status: "open" })
      .map((alert) => alert.alert_type)
      .sort();

    expect(result.alerts).toBe(5);
    expect(alertTypes).toEqual([
      "approval_fast_path_error",
      "coordinator_stalled",
      "digest_flush_stalled",
      "guardian_inbox_stalled",
      "scheduler_stalled"
    ]);
  });

test("records detector failure in last_error without throwing", async () => {
    const db = await openFixtureDatabase();
    const result = await runPiGuardianWatchdogOnce(db, {
      checks: [{
        component: "coordinator",
        run: () => {
          throw new Error("probe failed with API_KEY=fixture-token at /Users/demo/private.log");
        }
      }],
      now: NOW
    });
    const status = getPiGuardianWatchdogStatus(db);

    expect(result).toMatchObject({ alerts: 0, errors: 1 });
    expect(status).toMatchObject({
      last_seen_at: "2026-06-19T01:00:00Z",
      last_success_at: ""
    });
    expect(status?.last_error).toContain("[redacted]");
    expect(status?.last_error).not.toContain("fixture-token");
    expect(status?.last_error).not.toContain("/Users/demo");
  });
}
