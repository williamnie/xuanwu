import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listImReplyDrafts, listSyncOutbox, getSyncOutbox } from "../db/repositories/imReplyOutbox.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import type { Issue } from "../db/repositories/issues.ts";
import {
  createPiIssueCompletionWatch,
  getPiIssueCompletionWatch,
  getPiNotificationIntent,
  listPiNotificationIntents
} from "../db/repositories/pi.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { buildFeishuConnectorConfig } from "./feishu.ts";
import { FeishuClientError } from "./feishuClient.ts";
import {
  ISSUE_COMPLETION_WATCH_INTENT_KIND,
  evaluatePiIssueCompletionWatchesForIssue
} from "../pi/issueCompletionWatchEvaluator.ts";
import { dispatchFeishuOutbox, type FeishuMessageSender } from "../pi/imReplyOutboxDispatcher.ts";
import { queueReadyFeishuCompletionWatchNotifications } from "./feishuCompletionWatchNotifications.ts";

const NOW = new Date("2026-06-29T08:00:00Z");
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Feishu completion watch notifications", () => {
  test("queues a completion watch summary through drafts and sync outbox", async () => {
    const db = await fixtureDatabase();
    try {
      const done = createIssue(db, { project_id: "demo", title: "Build mobile flow", status: "todo" });
      const failed = createIssue(db, { project_id: "demo", title: "Fix backend retry", status: "todo" });
      const watch = createWatch(db, [done.id, failed.id]);

      satisfyIssue(db, done, "done");
      satisfyIssue(db, failed, "failed", "tests failed");

      const result = queueReadyFeishuCompletionWatchNotifications(db);
      const drafts = listImReplyDrafts(db, { source: "feishu" });
      const outbox = listSyncOutbox(db, { source: "feishu" });
      const storedIntent = getPiNotificationIntent(db, watchIntent(db).id);
      const content = outbox[0]?.content ?? "";

      expect(result).toMatchObject({ failed: 0, queued: 1, scanned: 1, skipped: 0 });
      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({
        target_chat_id: "oc_watch",
        target_message_id: "om_watch",
        target_thread_id: "omt_watch"
      });
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({
        issue_id: failed.id,
        status: "pending",
        target_chat_id: "oc_watch",
        target_message_id: "om_watch",
        target_thread_id: "omt_watch"
      });
      expect(storedIntent).toMatchObject({ error: "", sent_outbox_id: outbox[0]?.id, state: "sent" });
      expect(getPiIssueCompletionWatch(db, watch.id)).toMatchObject({ status: "satisfied" });
      expect(content).toContain("玄武 Supervisor：你关注的 2 个 issue 已结束");
      expect(content).toContain("done：1");
      expect(content).toContain("failed：1");
      expect(content).toContain("cancelled：0");
      expect(content).toContain("pending_verification：0");
      expect(content).toContain(`#${done.id} Build mobile flow — done`);
      expect(content).toContain(`#${failed.id} Fix backend retry — failed`);
      expect(content).toContain("先处理失败");
    } finally {
      db.close();
    }
  });

  test("does not create duplicate outbox records for the same watch", async () => {
    const db = await fixtureDatabase();
    try {
      const issue = createIssue(db, { project_id: "demo", title: "One shot", status: "todo" });
      createWatch(db, [issue.id]);
      satisfyIssue(db, issue, "done");

      const first = queueReadyFeishuCompletionWatchNotifications(db);
      const second = queueReadyFeishuCompletionWatchNotifications(db);

      expect(first).toMatchObject({ failed: 0, queued: 1 });
      expect(second).toMatchObject({ failed: 0, queued: 0 });
      expect(listImReplyDrafts(db, { source: "feishu" })).toHaveLength(1);
      expect(listSyncOutbox(db, { source: "feishu" })).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("keeps missing-target watch intents retryable with visible error state", async () => {
    const db = await fixtureDatabase();
    try {
      const issue = createIssue(db, { project_id: "demo", title: "No target", status: "todo" });
      const watch = createPiIssueCompletionWatch(db, {
        issue_ids: [issue.id],
        origin_conversation_id: "feishu-chat-missing-target",
        project_id: "demo",
        source_event_id: "watch-missing-target",
        target_channel: "feishu"
      });
      satisfyIssue(db, issue, "done");

      const result = queueReadyFeishuCompletionWatchNotifications(db);
      const intent = getPiNotificationIntent(db, watchIntent(db).id);

      expect(result).toMatchObject({ failed: 1, queued: 0, scanned: 1, skipped: 0 });
      expect(listSyncOutbox(db, { source: "feishu" })).toHaveLength(0);
      expect(intent).toMatchObject({ sent_outbox_id: 0, state: "ready" });
      expect(intent?.error).toContain("missing_feishu_target");
      expect(getPiIssueCompletionWatch(db, watch.id)).toMatchObject({
        error: "missing_feishu_target",
        status: "satisfied"
      });
    } finally {
      db.close();
    }
  });

  test("leaves Feishu API failures in sync outbox retry state", async () => {
    const db = await fixtureDatabase();
    try {
      const issue = createIssue(db, { project_id: "demo", title: "Retry send", status: "todo" });
      createWatch(db, [issue.id]);
      satisfyIssue(db, issue, "pending_verification");
      queueReadyFeishuCompletionWatchNotifications(db);
      const outboxID = listSyncOutbox(db, { source: "feishu" })[0]?.id ?? 0;
      const sender = new FakeFeishuSender([
        new FeishuClientError("token expired", { kind: "temporary", status: 500 })
      ]);

      const result = await dispatchFeishuOutbox({
        config: feishuConfig(),
        database: db,
        now: NOW,
        sender
      });
      const stored = getSyncOutbox(db, outboxID);

      expect(result).toMatchObject({ failed: 0, processed: 1, retry: 1, sent: 0 });
      expect(stored).toMatchObject({ status: "retry" });
      expect(stored?.last_error).toBe("token [redacted]");
      expect(stored?.cooldown_until).not.toBe("");
    } finally {
      db.close();
    }
  });
});

class FakeFeishuSender implements FeishuMessageSender {
  calls: Array<{ receiveId: string; receiveIdType: string; text: string }> = [];

  constructor(private readonly outcomes: Array<{ messageId: string } | Error>) {}

  async sendTextMessage(input: {
    receiveId: string;
    receiveIdType: string;
    text: string;
  }): Promise<{ messageId: string }> {
    this.calls.push(input);
    const next = this.outcomes.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("unexpected fake send");
    return next;
  }
}

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-completion-watch-notify-"));
  tempRoots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, provider_config_json, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["demo", "Demo", join(root, "project"), "codex", '{"capabilities":["issue_execution"]}', 1,
      "2026-06-29T00:00:00Z", "2026-06-29T00:00:00Z"]
  );
  return db;
}

function createWatch(db: RunnerDatabase, issueIDs: number[]) {
  return createPiIssueCompletionWatch(db, {
    issue_ids: issueIDs,
    origin_conversation_id: "feishu-chat-oc_watch-20260629",
    project_id: "demo",
    source_event_id: `watch-${issueIDs.join("-")}`,
    target_channel: "feishu",
    target_chat_id: "oc_watch",
    target_message_id: "om_watch",
    target_thread_id: "omt_watch"
  });
}

function satisfyIssue(db: RunnerDatabase, issue: Issue, status: string, error = ""): void {
  updateIssue(db, issue.id, { error, status });
  evaluatePiIssueCompletionWatchesForIssue(db, {
    eventID: `event-${issue.id}-${status}`,
    eventType: "issue.status_changed",
    issueID: issue.id,
    projectID: issue.project_id,
    status
  });
}

function watchIntent(db: RunnerDatabase) {
  const intent = listPiNotificationIntents(db, { kind: ISSUE_COMPLETION_WATCH_INTENT_KIND })[0];
  if (!intent) throw new Error("watch intent missing");
  return intent;
}

function feishuConfig() {
  return buildFeishuConnectorConfig({
    feishuAllowedChatIds: "oc_watch",
    feishuAppId: "cli_app_id",
    feishuAppSecret: "app-secret-value",
    feishuVerificationToken: "verify-token"
  });
}
