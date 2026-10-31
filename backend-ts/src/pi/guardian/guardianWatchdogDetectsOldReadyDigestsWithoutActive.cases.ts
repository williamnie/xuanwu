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

export function registerDetectsOldReadyDigestsWithoutActive() {
test("detects old ready digests without active run groups, including failures in backoff", async () => {
    const db = await openFixtureDatabase();
    for (const id of ["stuck", "retrying", "fresh", "linked", "aggregated"]) {
      createPiNotificationIntent(db, {
        id, idempotency_key: id, kind: "digest", project_id: "demo",
        run_group_id: id, flush_reason: "completed", flush_sequence: 1, target_channel: "telegram",
        ready_at: id === "fresh" ? NOW.toISOString() : "2026-06-19T00:00:00Z",
        state: id === "aggregated" ? "aggregated" : "ready",
        sent_outbox_id: id === "linked" ? 1 : 0,
        error: id === "retrying" ? "missing_im_target" : "",
        flush_after_at: id === "retrying" ? "2026-06-19T01:15:00Z" : ""
      });
    }
    db.sqlite.run("update pi_notification_intents set created_at='2026-06-19T00:00:00Z'");
    const result = await runPiGuardianWatchdogOnce(db, { now: NOW, staleAfterMs: STALE_MS });
    expect(result.checks.filter((check) => check.component === "digest")).toEqual([
      expect.objectContaining({
        alert_type: "digest_flush_stalled", ok: false, project_id: "demo",
        evidence: expect.objectContaining({ count: 2, reason: "ready_notifications_stalled" })
      })
    ]);
    expect(sideEffectCounts(db).outbox).toBe(0);
    db.sqlite.run("update pi_notification_intents set state='agent_pending' where id in ('stuck','retrying')");
    const recovered = await runPiGuardianWatchdogOnce(db, { now: NOW, staleAfterMs: STALE_MS });
    expect(recovered.checks.filter((check) => check.component === "digest")).toEqual([
      { component: "digest", ok: true }
    ]);
  });

test("reports granular stage timings without exposing SQL payloads", async () => {
    const db = await openFixtureDatabase();
    const timings: Array<{ stage: string; status: string }> = [];
    await runPiGuardianWatchdogOnce(db, {
      checks: [{ component: "pi_runtime", run: () => ({ component: "pi_runtime", ok: true }) }],
      now: NOW,
      timingObserver: (timing) => timings.push({ stage: timing.stage, status: timing.status })
    });

    expect(timings).toEqual([
      { stage: "approval_expiry", status: "succeeded" },
      { stage: "suppress_unroutable_intents", status: "succeeded" },
      { stage: "probe:pi_runtime", status: "succeeded" },
      { stage: "write_status", status: "succeeded" }
    ]);
  });

test("writes UI alert before durable Feishu delivery and records its sent receipt", async () => {
    const db = await openFixtureDatabase();
    const sender = new FakeGuardianFeishuSender([{ messageId: "om_guardian_sent_1" }], () => {
      const alert = listPiGuardianAlerts(db, { projectId: "demo", status: "open" })[0];
      expect(alert).toMatchObject({ direct_feishu_state: "not_attempted", ui_visible: 1 });
    });
    insertProject(db, "demo");

    await runPiGuardianWatchdogOnce(db, {
      checks: [failingProbe()],
      delivery: guardianDelivery(db, sender),
      now: NOW,
      staleAfterMs: STALE_MS
    });
    const alerts = listPiGuardianAlerts(db, { projectId: "demo", status: "open" });

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      direct_feishu_message_id: "om_guardian_sent_1",
      direct_feishu_state: "sent",
      next_retry_at: "2026-06-19T01:15:00Z",
      retry_count: 0,
      status: "open",
      ui_visible: 1
    });
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]).toMatchObject({ receiveId: "oc_guardian", receiveIdType: "chat_id" });
    expect(sender.calls[0]?.text).toContain("玄武 Supervisor：项目 PI Runtime 不可用");
    expect(sender.calls[0]?.text).toContain("发生了什么：项目的 PI Agent、会话或运行配置不可用");
    expect(sender.calls[0]?.text).toContain("需要你处理：检查项目的 PI Agent 是否存在并启用");
    expect(sender.calls[0]?.text).toContain("影响位置：项目 demo");
    expect(sender.calls[0]?.text).not.toContain("alert=");
    expect(sender.calls[0]?.text).not.toContain("severity=");
    expect(sender.calls[0]?.text).not.toContain("fixture-token");
    expect(sender.calls[0]?.text).not.toContain("/Users/demo");
    expect(sideEffectCounts(db)).toEqual({
      conversations: 0,
      drafts: 1,
      intents: 0,
      outbox: 1
    });
  });

test("keeps UI alert open when direct Feishu falls back to retry", async () => {
    const db = await openFixtureDatabase();
    const sender = new FakeGuardianFeishuSender([
      new FeishuClientError("socket closed XUANWU_AUTH_TOKEN=fixture-token at /Users/demo/private.log", {
        kind: "temporary",
        retryAfterSeconds: 30
      })
    ]);
    insertProject(db, "demo");

    await runPiGuardianWatchdogOnce(db, {
      checks: [failingProbe()],
      delivery: guardianDelivery(db, sender),
      now: NOW,
      staleAfterMs: STALE_MS
    });
    const alert = listPiGuardianAlerts(db, { projectId: "demo", status: "open" })[0];

    expect(alert).toMatchObject({
      direct_feishu_state: "retry",
      max_retry_count: 3,
      next_retry_at: "2026-06-19T01:15:00Z",
      retry_count: 1,
      status: "open",
      ui_visible: 1
    });
    expect(alert.direct_feishu_error).toContain("[redacted");
    expect(alert.direct_feishu_error).not.toContain("fixture-token");
    expect(alert.direct_feishu_error).not.toContain("/Users/demo");
    expect(sideEffectCounts(db)).toEqual({
      conversations: 0,
      drafts: 1,
      intents: 0,
      outbox: 1
    });
  });

test("backs off urgent alert retries and keeps UI visible after max cap", async () => {
    const db = await openFixtureDatabase();
    const sender = new FakeGuardianFeishuSender([
      new FeishuClientError("temporary outage 1", { kind: "temporary" }),
      new FeishuClientError("temporary outage 2", { kind: "temporary" }),
      new FeishuClientError("temporary outage 3", { kind: "temporary" })
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
    const alert = listPiGuardianAlerts(db, { projectId: "demo", status: "open" })[0];

    expect(sender.calls).toHaveLength(3);
    expect(alert).toMatchObject({
      direct_feishu_state: "failed",
      next_retry_at: "",
      retry_count: 3,
      status: "open",
      ui_visible: 1
    });
  });
}
