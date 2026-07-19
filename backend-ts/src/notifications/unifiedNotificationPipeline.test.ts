import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { createExternalEvent } from "../db/repositories/externalEvents.ts";
import { createExternalLink } from "../db/repositories/externalLinks.ts";
import { getSyncOutbox, listSyncOutbox } from "../db/repositories/imReplyOutbox.ts";
import {
  createPiNotificationPreference,
  listPiNotificationIntents,
  upsertProjectPiPolicy
} from "../db/repositories/pi.ts";
import { queueDailyNotificationDigests } from "./dailyDigest.ts";
import {
  dispatchNotificationOutbox,
  NotificationChannelError,
  type NotificationChannelSender
} from "./notificationOutbox.ts";
import { routeNotification } from "./unifiedNotificationPipeline.ts";
import { queueFeishuHandoffNotification } from "../integrations/feishuNotifications.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("unified notification intent/outbox", () => {
  test("suppresses a replay when historical notification links predate unified intents", async () => {
    const db = await fixture();
    try {
      const issue = createIssue(db, { project_id: "demo", status: "done", title: "Historical delivery" });
      createExternalLink(db, {
        external_id: `historical:${issue.id}:done`,
        external_type: "fixture_historical_done",
        issue_id: issue.id,
        project_id: "demo",
        relationship: "notification",
        source: "feishu"
      });

      const [result] = routeNotification(db, {
        content: "historical completion replay",
        idempotencyKey: `historical:issue:${issue.id}:done`,
        issueID: issue.id,
        kind: "issue_done",
        notificationID: `historical:${issue.id}:done`,
        notificationType: "fixture_historical_done",
        projectID: "demo",
        routes: [{ channel: "feishu", chatID: "oc_historical" }],
        sourceEventID: `issue:${issue.id}:done`,
        sourceEventType: "issue.status_changed",
        summary: `issue #${issue.id} historical completion`
      });

      expect(result).toMatchObject({ queued: false, reason: "duplicate" });
      expect(listSyncOutbox(db)).toHaveLength(0);
      expect(listPiNotificationIntents(db, { issueId: issue.id })).toMatchObject([
        expect.objectContaining({
          decision: "suppress",
          error: "duplicate_notification_link",
          sent_outbox_id: 0,
          state: "suppressed"
        })
      ]);
    } finally {
      db.close();
    }
  });

  test("dedupes one event per channel, preserves deep links, and retries a failed channel", async () => {
    const db = await fixture();
    try {
      const issue = createIssue(db, { project_id: "demo", status: "done", title: "Multi-channel delivery" });
      const input = {
        content: "issue completed",
        deepLink: `/api/issues/${issue.id}`,
        idempotencyKey: `issue_done:demo:${issue.id}:event-1`,
        issueID: issue.id,
        kind: "issue_done",
        notificationType: "fixture_issue_done",
        now: new Date("2026-07-18T12:00:00.000Z"),
        payload: { status: "done" },
        projectID: "demo",
        routes: [
          { channel: "feishu", chatID: "oc_fixture" },
          { channel: "webhook", chatID: "hook_fixture" }
        ],
        sourceEventID: "event-1",
        sourceEventType: "issue.status_changed",
        summary: `issue #${issue.id} done`
      };

      const first = routeNotification(db, input);
      const replay = routeNotification(db, input);
      const intents = listPiNotificationIntents(db, { issueId: issue.id });
      const outbox = listSyncOutbox(db);

      expect(first.map((item) => [item.route.channel, item.queued])).toEqual([
        ["feishu", true],
        ["webhook", true]
      ]);
      expect(replay.map((item) => item.reason)).toEqual(["duplicate", "duplicate"]);
      expect(intents).toHaveLength(2);
      expect(outbox).toHaveLength(2);
      expect(new Set(outbox.map((item) => item.source))).toEqual(new Set(["feishu", "webhook"]));
      expect(outbox.every((item) => item.content.includes(`/api/issues/${issue.id}`))).toBe(true);
      expect(intents.every((intent) => JSON.parse(intent.payload_json).deep_link === `/api/issues/${issue.id}`)).toBe(true);

      const webhook = new SequenceSender([
        new NotificationChannelError("temporary outage", { retryAfterSeconds: 5 }),
        { deliveryID: "hook-delivered" }
      ]);
      const firstDispatch = await dispatchNotificationOutbox({
        database: db,
        now: new Date("2026-07-18T12:01:00.000Z"),
        senders: {
          feishu: new SequenceSender([{ deliveryID: "om-delivered" }]),
          webhook
        }
      });
      const retry = listSyncOutbox(db, { source: "webhook" })[0]!;

      expect(firstDispatch).toMatchObject({ failed: 0, processed: 2, retry: 1, sent: 1 });
      expect(retry).toMatchObject({ attempt_count: 1, status: "retry" });
      expect(retry.cooldown_until).toBe("2026-07-18T12:01:05.000Z");

      const secondDispatch = await dispatchNotificationOutbox({
        database: db,
        now: new Date("2026-07-18T12:01:06.000Z"),
        senders: { webhook }
      });
      expect(secondDispatch).toMatchObject({ failed: 0, processed: 1, retry: 0, sent: 1 });
      expect(getSyncOutbox(db, retry.id)).toMatchObject({
        attempt_count: 2,
        feishu_message_id: "hook-delivered",
        status: "sent"
      });
    } finally {
      db.close();
    }
  });

  test("defers ordinary notifications in quiet hours and emits one preference-routed daily digest", async () => {
    const db = await fixture();
    try {
      upsertProjectPiPolicy(db, {
        project_id: "demo",
        quiet_hours_json: { daily: [{ end: "08:00", start: "22:00" }] },
        timezone: "UTC"
      });
      createPiNotificationPreference(db, {
        digest_policy_json: { channels: ["feishu"], daily_at: "09:00" },
        effective_after_sequence: 0,
        id: "pref-demo-daily",
        mode: "normal",
        project_id: "demo",
        scope: "project"
      });
      const issue = createIssue(db, { project_id: "demo", status: "done", title: "Quiet delivery" });
      const routed = routeNotification(db, {
        content: "quiet completion",
        deepLink: `/api/issues/${issue.id}`,
        idempotencyKey: `quiet:issue:${issue.id}`,
        issueID: issue.id,
        kind: "issue_done",
        notificationType: "fixture_quiet_done",
        now: new Date("2026-07-18T23:00:00.000Z"),
        projectID: "demo",
        routes: [
          { channel: "feishu", chatID: "oc_quiet" },
          { channel: "webhook", chatID: "hook_filtered" }
        ],
        summary: `issue #${issue.id} completed in quiet hours`
      });
      const source = routed.find((item) => item.route.channel === "feishu")!.intent;
      db.sqlite.run("update pi_notification_intents set created_at=?, updated_at=? where id=?", [
        "2026-07-18T23:00:00.000Z",
        "2026-07-18T23:00:00.000Z",
        source.id
      ]);

      expect(routed.map((item) => [item.route.channel, item.reason])).toEqual([
        ["feishu", "aggregated"],
        ["webhook", "channel_filtered"]
      ]);
      expect(source).toMatchObject({
        decision: "aggregate",
        flush_after_at: "2026-07-19T08:00:00.000Z",
        preference_id: "pref-demo-daily",
        state: "aggregated"
      });
      expect(listSyncOutbox(db)).toHaveLength(0);
      expect(queueDailyNotificationDigests(db, { now: new Date("2026-07-19T07:59:00.000Z") }))
        .toMatchObject({ queued: 0 });

      const digest = queueDailyNotificationDigests(db, { now: new Date("2026-07-19T09:00:00.000Z") });
      const replay = queueDailyNotificationDigests(db, { now: new Date("2026-07-19T09:01:00.000Z") });
      const outbox = listSyncOutbox(db, { source: "feishu" });
      const intents = listPiNotificationIntents(db);

      expect(digest).toMatchObject({ aggregated: 1, failed: 0, queued: 1 });
      expect(replay).toMatchObject({ queued: 0 });
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.content).toContain("Daily Digest · 2026-07-19 · 1 条");
      expect(outbox[0]?.content).toContain(`/api/issues/${issue.id}`);
      expect(intents.filter((intent) => intent.kind === "daily_digest")).toHaveLength(1);
      expect(intents.find((intent) => intent.id === source.id)).toMatchObject({
        sent_outbox_id: outbox[0]?.id,
        state: "sent"
      });
    } finally {
      db.close();
    }
  });

  test("routes a Handoff delivery event through the same intent and outbox exactly once", async () => {
    const db = await fixture();
    try {
      const issue = createIssue(db, { project_id: "demo", status: "done", title: "Handoff delivery" });
      const external = createExternalEvent(db, {
        content: "handoff source",
        dedupe_key: `feishu:handoff:${issue.id}`,
        external_id: `om_handoff_${issue.id}`,
        normalized_message: { chat_id: "oc_handoff", message_id: `om_handoff_${issue.id}` },
        source: "feishu"
      });
      createExternalLink(db, {
        conversation_id: "oc_handoff",
        external_event_id: external.id,
        external_type: "feishu_message",
        issue_id: issue.id,
        project_id: "demo",
        relationship: "created_issue",
        source: "feishu"
      });
      const event = {
        issueId: issue.id,
        payload: JSON.stringify({
          handoff_id: "xw:handoff:derived:fixture",
          href: "#/handoffs/xw%3Ahandoff%3Aderived%3Afixture",
          revision: 2,
          status: "ready",
          summary: "Ready · branch_commit · Next: review"
        }),
        projectId: "demo",
        status: "ready",
        type: "handoff.notification"
      };

      expect(queueFeishuHandoffNotification(db, event)).toMatchObject({ queued: true });
      expect(queueFeishuHandoffNotification(db, event)).toMatchObject({ queued: false, reason: "duplicate" });
      const outbox = listSyncOutbox(db, { source: "feishu" });
      const intents = listPiNotificationIntents(db, { issueId: issue.id });

      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.content).toContain("#/handoffs/xw%3Ahandoff%3Aderived%3Afixture");
      expect(intents).toMatchObject([
        expect.objectContaining({ kind: "handoff_ready", sent_outbox_id: outbox[0]?.id, state: "sent" })
      ]);
    } finally {
      db.close();
    }
  });
});

class SequenceSender implements NotificationChannelSender {
  constructor(private readonly outcomes: Array<{ deliveryID: string } | Error>) {}

  async send(): Promise<{ deliveryID: string }> {
    const next = this.outcomes.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("unexpected fixture send");
    return next;
  }
}

async function fixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "unified-notification-"));
  roots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(`insert into projects (id, name, cwd, provider, provider_config_json, sort_order, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?)`, [
    "demo", "Demo", join(root, "project"), "codex", '{"capabilities":["issue_execution"]}', 1,
    "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"
  ]);
  return db;
}
