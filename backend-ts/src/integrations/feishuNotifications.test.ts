import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { buildConfig } from "../config/env.ts";
import { createExternalEvent } from "../db/repositories/externalEvents.ts";
import { createExternalLink } from "../db/repositories/externalLinks.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { listSyncOutbox } from "../db/repositories/imReplyOutbox.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { EventBus } from "../events/bus.ts";
import { createDefaultRouter } from "../http/server.ts";
import type { FeishuMessageSender } from "../pi/imReplyOutboxDispatcher.ts";
import { queueFeishuIssueStatusNotification } from "./feishuNotifications.ts";

const tempRoots: string[] = [];
const BASE_URL = "http://127.0.0.1:3008";

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Feishu notification queue", () => {
  test("queues one approved Feishu outbox item when a linked issue is completed", async () => {
    const db = await fixtureDatabase();
    try {
      const issueID = linkedFeishuIssue(db);
      updateIssue(db, issueID, { status: "done", error: "" });

      const first = queueFeishuIssueStatusNotification(db, issueID);
      const second = queueFeishuIssueStatusNotification(db, issueID);
      const outbox = listSyncOutbox(db, { source: "feishu" });

      expect(first).toMatchObject({ queued: true, reason: "queued" });
      expect(second).toMatchObject({ queued: false, reason: "duplicate" });
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({
        content: expect.stringContaining("issue #1 已完成"),
        issue_id: issueID,
        status: "pending",
        target_chat_id: "oc_group"
      });
    } finally {
      db.close();
    }
  });

  test("router queues Feishu completion notification when linked issue is patched done", async () => {
    const db = await fixtureDatabase();
    const bus = new EventBus();
    try {
      const issueID = linkedFeishuIssue(db);
      const router = createDefaultRouter({ bus, database: db });

      const response = await router.handle(new Request(`${BASE_URL}/api/issues/${issueID}`, {
        body: JSON.stringify({ error: "", status: "done" }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      }));
      const outbox = listSyncOutbox(db, { source: "feishu" });

      expect(response.status).toBe(200);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({
        content: expect.stringContaining("issue #1 已完成"),
        issue_id: issueID,
        target_chat_id: "oc_group"
      });
    } finally {
      db.close();
    }
  });

  test("router queues Feishu completion notification when verification is accepted", async () => {
    const db = await fixtureDatabase();
    const bus = new EventBus();
    try {
      const issueID = linkedFeishuIssue(db);
      updateIssue(db, issueID, { error: "bun test passed", status: "pending_verification" });
      const router = createDefaultRouter({ bus, database: db });

      const response = await router.handle(new Request(`${BASE_URL}/api/issues/${issueID}/verification`, {
        body: JSON.stringify({ action: "accept", comment: "验收通过" }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }));
      const outbox = listSyncOutbox(db, { source: "feishu" });

      expect(response.status).toBe(200);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({
        content: expect.stringContaining("issue #1 已完成"),
        issue_id: issueID,
        target_chat_id: "oc_group"
      });
    } finally {
      db.close();
    }
  });

  test("router dispatches Feishu completion notification automatically", async () => {
    const db = await fixtureDatabase();
    const bus = new EventBus();
    const sender = new FakeFeishuSender();
    const config = buildConfig({ feishuAppId: "cli_app_id", feishuAppSecret: "app-secret-value" });
    try {
      const issueID = linkedFeishuIssue(db);
      const router = createDefaultRouter({ bus, config, database: db, feishuSender: sender });

      const response = await router.handle(new Request(`${BASE_URL}/api/issues/${issueID}`, {
        body: JSON.stringify({ error: "", status: "done" }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      }));
      await until(() => sender.calls.length > 0);
      const outbox = listSyncOutbox(db, { source: "feishu" });

      expect(response.status).toBe(200);
      expect(sender.calls).toEqual([{
        receiveId: "oc_group",
        receiveIdType: "chat_id",
        text: "Pi：issue #1 已完成：Feishu task\n验证状态：已标记完成，未附加验证摘要。"
      }]);
      expect(outbox[0]).toMatchObject({ feishu_message_id: "om_auto_sent_1", status: "sent" });
    } finally {
      db.close();
    }
  });
});

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-feishu-notify-"));
  tempRoots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, provider_config_json, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["demo", "Demo", join(root, "project"), "codex", '{"capabilities":["issue_execution"]}', 1,
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  return db;
}

function linkedFeishuIssue(db: RunnerDatabase): number {
  const issue = createIssue(db, { project_id: "demo", title: "Feishu task", status: "triage" });
  const event = createExternalEvent(db, {
    content: "帮我修复问题",
    dedupe_key: "feishu:message:om_task",
    external_id: "om_task",
    normalized_message: { chat_id: "oc_group", message_id: "om_task" },
    source: "feishu"
  });
  createExternalLink(db, {
    conversation_id: "oc_group",
    external_event_id: event.id,
    external_type: "feishu_message",
    issue_id: issue.id,
    project_id: "demo",
    relationship: "created_issue",
    source: "feishu"
  });
  return issue.id;
}

class FakeFeishuSender implements FeishuMessageSender {
  calls: Array<{ receiveId: string; receiveIdType: string; text: string }> = [];

  async sendTextMessage(input: { receiveId: string; receiveIdType: string; text: string }): Promise<{ messageId: string }> {
    this.calls.push(input);
    return { messageId: `om_auto_sent_${this.calls.length}` };
  }
}

async function until(check: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error("condition timed out");
}
