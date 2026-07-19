import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import {
  cancelAutomationWatch,
  createAutomationWatch,
  getAutomationWatch,
  migrateLegacyCompletionWatches,
  type CreateAutomationWatchInput
} from "../db/repositories/automationWatches.ts";
import { createExternalEvent } from "../db/repositories/externalEvents.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { markSyncOutboxSent } from "../db/repositories/imReplyOutboxDispatch.ts";
import { createPiIssueCompletionWatch, markPiIssueCompletionWatchSatisfied } from "../db/repositories/pi.ts";
import type { AutomationAudit, AutomationID } from "../domain/automation/contracts.ts";
import { runAgentCommunicationGatewayOnce } from "../notifications/agentCommunicationGateway.ts";
import { runWatchAutomationsOnce } from "./watchAutomationRuntime.ts";

const roots: string[] = [];
const CREATED_AT = "2026-07-18T00:00:00.000Z";
const EVALUATED_AT = "2026-07-18T00:05:00.000Z";

afterEach(async () => { while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true }); });

describe("Watch Automation runtime", () => {
  test("observes completion and failure fixtures and queues each notification only once", async () => {
    const db = await fixture();
    try {
      const completedIssue = issue(db, "completion");
      const failedIssue = issue(db, "failure");
      const completed = createIssueWatch(db, "completion", completedIssue.id);
      const failed = createIssueWatch(db, "failure", failedIssue.id);
      expect(createIssueWatch(db, "completion", completedIssue.id).automation_id).toBe(completed.automation_id);
      expect(count(db, "automation_watches")).toBe(2);
      setIssueStatus(db, completedIssue.id, "done");
      setIssueStatus(db, failedIssue.id, "failed");

      expect(runWatchAutomationsOnce(db, { now: EVALUATED_AT })).toMatchObject({
        failed: 0, queued: 2, satisfied: 2, scanned: 2
      });
      expect(getAutomationWatch(db, completed.automation_id)).toMatchObject({ outcome: "completion", status: "satisfied" });
      expect(getAutomationWatch(db, failed.automation_id)).toMatchObject({ outcome: "failure", status: "satisfied" });
      await flushAgentMessages(db);
      expect(runWatchAutomationsOnce(db, { now: EVALUATED_AT })).toMatchObject({ delivered: 0, queued: 0, scanned: 0 });
      expect(count(db, "sync_outbox")).toBe(1);
      markQueuedOutboxesSent(db);
      expect(runWatchAutomationsOnce(db, { now: EVALUATED_AT })).toMatchObject({
        delivered: 2, failed: 0, queued: 0, satisfied: 0, scanned: 0
      });
      expect(getAutomationWatch(db, completed.automation_id)).toMatchObject({ outcome: "completion", status: "notified" });
      expect(getAutomationWatch(db, failed.automation_id)).toMatchObject({ outcome: "failure", status: "notified" });
      expect(count(db, "pi_notification_intents")).toBe(2);
      expect(count(db, "sync_outbox")).toBe(1);
      expect(count(db, "external_links", "external_type='agent_communication'")).toBe(1);
    } finally { db.close(); }
  });

  test("expires timed-out watches once and cancellation remains silent and audited", async () => {
    const db = await fixture();
    try {
      const timeoutIssue = issue(db, "timeout");
      const cancelledIssue = issue(db, "cancel");
      const timeout = createIssueWatch(db, "timeout", timeoutIssue.id, "2026-07-18T00:01:00.000Z");
      const cancelled = createIssueWatch(db, "cancel", cancelledIssue.id);
      cancelAutomationWatch(db, cancelled.automation_id, audit("cancel", "2026-07-18T00:02:00.000Z"));

      expect(runWatchAutomationsOnce(db, { now: EVALUATED_AT })).toMatchObject({
        expired: 1, failed: 0, queued: 1, scanned: 1
      });
      expect(getAutomationWatch(db, timeout.automation_id)).toMatchObject({ outcome: "timeout", status: "expired" });
      await flushAgentMessages(db);
      markQueuedOutboxesSent(db);
      expect(runWatchAutomationsOnce(db, { now: EVALUATED_AT })).toMatchObject({ delivered: 1, queued: 0 });
      expect(getAutomationWatch(db, timeout.automation_id)).toMatchObject({ outcome: "timeout", status: "notified" });
      expect(getAutomationWatch(db, cancelled.automation_id)).toMatchObject({ outcome: "cancelled", status: "cancelled" });
      expect(count(db, "pi_notification_intents")).toBe(1);
      expect(eventTypes(db, cancelled.automation_id)).toContain("automation.watch_cancelled.v1");
    } finally { db.close(); }
  });

  test("observes only new matching external thread events and advances an audited cursor", async () => {
    const db = await fixture();
    try {
      createExternalEvent(db, externalEvent("before", "thread-a"), new Date(CREATED_AT));
      const watch = createAutomationWatch(db, {
        condition: { event_types: ["message"], type: "external_thread_event" },
        dedupe_key: "watch:thread-a",
        name: "Thread A",
        notification_target: notificationTarget(),
        project_id: "demo",
        subject: { kind: "external_thread", provider: "feishu", thread_id: "thread-a" }
      }, audit("thread-create", CREATED_AT));
      createExternalEvent(db, externalEvent("other", "thread-b"), new Date("2026-07-18T00:01:00.000Z"));

      expect(runWatchAutomationsOnce(db, { now: "2026-07-18T00:02:00.000Z" })).toMatchObject({
        cursor_advanced: 1, queued: 0, scanned: 1
      });
      expect(eventTypes(db, watch.automation_id)).toContain("automation.watch_cursor_advanced.v1");
      const matched = createExternalEvent(db, externalEvent("matched", "thread-a"), new Date("2026-07-18T00:03:00.000Z"));

      expect(runWatchAutomationsOnce(db, { now: EVALUATED_AT })).toMatchObject({ queued: 1, satisfied: 1 });
      expect(getAutomationWatch(db, watch.automation_id)).toMatchObject({
        matched_ref: `external_event:${matched.id}`, outcome: "thread_event", status: "satisfied"
      });
      await flushAgentMessages(db);
      markQueuedOutboxesSent(db);
      expect(runWatchAutomationsOnce(db, { now: EVALUATED_AT }).delivered).toBe(1);
      expect(getAutomationWatch(db, watch.automation_id)).toMatchObject({
        matched_ref: `external_event:${matched.id}`, outcome: "thread_event", status: "notified"
      });
      expect(count(db, "sync_outbox")).toBe(1);
    } finally { db.close(); }
  });

  test("migrates legacy completion watches as idempotent non-notifying shadows", async () => {
    const db = await fixture();
    try {
      const watched = issue(db, "legacy");
      const legacy = createPiIssueCompletionWatch(db, {
        condition: { terminal_statuses: ["done", "failed", "cancelled"] },
        issue_ids: [watched.id],
        project_id: "demo",
        source_event_id: "legacy-event",
        target_channel: "feishu",
        target_chat_id: "chat-watch"
      });
      const migrationAudit = audit("legacy-migration", CREATED_AT);
      expect(migrateLegacyCompletionWatches(db, { audit: migrationAudit, dryRun: true })).toMatchObject({ created: 1, scanned: 1 });
      expect(migrateLegacyCompletionWatches(db, { audit: migrationAudit })).toMatchObject({ created: 1, scanned: 1 });
      expect(migrateLegacyCompletionWatches(db, { audit: audit("legacy-replay", CREATED_AT) })).toMatchObject({
        created: 0, refreshed: 0, unchanged: 1
      });
      const shadow = shadowFor(db, legacy.id);
      expect(shadow).toMatchObject({ migration_mode: "legacy_shadow", status: "watching" });
      expect(runWatchAutomationsOnce(db, { now: EVALUATED_AT }).scanned).toBe(0);

      markPiIssueCompletionWatchSatisfied(db, legacy.id);
      expect(migrateLegacyCompletionWatches(db, { audit: audit("legacy-refresh", EVALUATED_AT) })).toMatchObject({ refreshed: 1 });
      expect(shadowFor(db, legacy.id)).toMatchObject({ migration_mode: "legacy_shadow", status: "satisfied" });
      expect(count(db, "pi_notification_intents")).toBe(0);
    } finally { db.close(); }
  });
});

async function fixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "watch-automation-"));
  roots.push(root);
  const db = await openDatabase({ stateDir: root });
  db.sqlite.run(`insert into projects (id, name, cwd, provider, created_at, updated_at)
    values ('demo', 'Demo', '/tmp/demo', 'fake-execution-only', ?, ?)`, [CREATED_AT, CREATED_AT]);
  return db;
}

function issue(db: RunnerDatabase, suffix: string) {
  return createIssue(db, { description: suffix, project_id: "demo", status: "in_progress", title: `Watch ${suffix}` });
}

function createIssueWatch(db: RunnerDatabase, suffix: string, issueID: number, expiresAt = "") {
  const input: CreateAutomationWatchInput = {
    condition: { match: "all", statuses: ["done", "failed", "cancelled"], type: "issue_status" },
    dedupe_key: `watch:${suffix}`,
    expires_at: expiresAt,
    id: `automation:watch-${suffix}` as AutomationID,
    name: `Watch ${suffix}`,
    notification_target: notificationTarget(),
    project_id: "demo",
    subject: { issue_ids: [issueID], kind: "issues" }
  };
  return createAutomationWatch(db, input, audit(`create-${suffix}`, CREATED_AT));
}

function notificationTarget() {
  return { channel: "feishu" as const, chat_id: "chat-watch", message_id: "message-watch", thread_id: "thread-watch" };
}

function audit(eventID: string, occurredAt: string): AutomationAudit {
  return {
    actor_id: "fixture-runner",
    actor_kind: "runner",
    correlation_id: `corr:${eventID}`,
    event_id: `event:${eventID}`,
    gate: { authority: "deterministic_policy", decision: "allow", policy_ref: "watch-test:v1" },
    occurred_at: occurredAt,
    reason: "watch automation fixture"
  };
}

function setIssueStatus(db: RunnerDatabase, issueID: number, status: string): void {
  db.sqlite.run("update issues set status=?, updated_at=? where id=?", [status, "2026-07-18T00:04:00.000Z", issueID]);
}

function externalEvent(id: string, threadID: string) {
  return {
    content: id,
    dedupe_key: `event:${id}`,
    event_type: "message",
    external_id: id,
    normalized_message: { chat_id: "chat-watch", message_id: id, thread_id: threadID },
    provider: "feishu",
    source: "feishu"
  };
}

function count(db: RunnerDatabase, table: string, where = "1=1"): number {
  return db.sqlite.query<{ count: number }, []>(`select count(*) as count from ${table} where ${where}`).get()?.count ?? 0;
}

function markQueuedOutboxesSent(db: RunnerDatabase): void {
  const ids = db.sqlite.query<{ id: number }, []>(
    "select id from sync_outbox where status in ('pending', 'queued', 'retry') order by id"
  ).all();
  ids.forEach(({ id }, index) => markSyncOutboxSent(db, id, {
    feishuMessageId: `feishu-message-${id}`,
    timestamp: new Date(`2026-07-18T00:06:0${index}.000Z`)
  }));
}

async function flushAgentMessages(db: RunnerDatabase): Promise<void> {
  await runAgentCommunicationGatewayOnce(db, {
    decide: async ({ intents }) => ({
      decision: "send",
      message: `你订阅的 ${intents.length} 项观察已结束，请查看结果。`,
      rationale: "explicit completion watch"
    })
  });
}

function eventTypes(db: RunnerDatabase, id: AutomationID): string[] {
  return db.sqlite.query<{ event_type: string }, [string]>(
    "select event_type from automation_events where automation_id=? order by occurred_at, event_id"
  ).all(id).map((row) => row.event_type);
}

function shadowFor(db: RunnerDatabase, legacyID: string) {
  const row = db.sqlite.query<{ automation_id: AutomationID }, [string]>(
    "select automation_id from automation_watches where legacy_watch_id=?"
  ).get(legacyID);
  return row ? getAutomationWatch(db, row.automation_id) : null;
}
