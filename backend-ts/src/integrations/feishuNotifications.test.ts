import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { buildConfig } from "../config/env.ts";
import { createExternalEvent } from "../db/repositories/externalEvents.ts";
import { createExternalLink } from "../db/repositories/externalLinks.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { listSyncOutbox } from "../db/repositories/imReplyOutbox.ts";
import { listPiNotificationIntents } from "../db/repositories/pi.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { EventBus } from "../events/bus.ts";
import { createHumanReviewRequest } from "../domain/review/humanReview.ts";
import { createDefaultRouter } from "../http/server.ts";
import { flushAgentCommunicationTestMessages } from "../notifications/agentCommunicationGateway.testSupport.ts";
import { dispatchFeishuOutbox, type FeishuMessageSender } from "../pi/imReplyOutboxDispatcher.ts";
import { queueFeishuIssueStatusNotification, queueFeishuPiNeedsUserNotification } from "./feishuNotifications.ts";

const tempRoots: string[] = [];
const BASE_URL = "http://127.0.0.1:3008";

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

function pendingRequiredHandoffReview(db: RunnerDatabase, issueID: number) {
  recordIssueEvent(db, issueID, "issue.handoff_policy_set.v1", {
    policy: "required",
    reason: "notification fixture"
  });
  return createHumanReviewRequest(db, issueID, {
    question: "是否接受当前验证结果？"
  });
}

describe("Feishu notification queue", () => {
  test("queues one approved Feishu outbox item when a linked issue is completed", async () => {
    const db = await fixtureDatabase();
    try {
      const issueID = linkedFeishuIssue(db);
      updateIssue(db, issueID, { status: "done", error: "" });

      const first = queueFeishuIssueStatusNotification(db, issueID);
      const second = queueFeishuIssueStatusNotification(db, issueID);
      await flushAgentCommunicationTestMessages(db);
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

  test("router rejects direct done patches without Evidence and does not notify", async () => {
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

      expect(response.status).toBe(400);
      expect(outbox).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("does not ask the human to accept again when PI still owns incomplete verification", async () => {
    const db = await fixtureDatabase();
    const bus = new EventBus();
    try {
      const issueID = linkedFeishuIssue(db);
      updateIssue(db, issueID, { error: "bun test passed", status: "pending_verification" });
      const review = pendingRequiredHandoffReview(db, issueID);
      const router = createDefaultRouter({ bus, database: db });

      const response = await router.handle(new Request(`${BASE_URL}/api/issues/${issueID}/verification`, {
        body: JSON.stringify({
          action: "accept",
          comment: "验收通过",
          review_request_id: review.id,
          review_revision: review.revision
        }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }));
      await flushAgentCommunicationTestMessages(db);
      const outbox = listSyncOutbox(db, { source: "feishu" });

      expect(response.status).toBe(200);
      expect(outbox).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("does not dispatch a generic pending-verification message without an explicit human question", async () => {
    const db = await fixtureDatabase();
    const bus = new EventBus();
    const sender = new FakeFeishuSender();
    const config = buildConfig({ feishuAppId: "cli_app_id", feishuAppSecret: "app-secret-value" });
    try {
      const issueID = linkedFeishuIssue(db);
      updateIssue(db, issueID, { error: "bun test passed", status: "pending_verification" });
      const review = pendingRequiredHandoffReview(db, issueID);
      const router = createDefaultRouter({ bus, config, database: db, feishuSender: sender });

      const response = await router.handle(new Request(`${BASE_URL}/api/issues/${issueID}/verification`, {
        body: JSON.stringify({
          action: "accept",
          comment: "验收通过",
          review_request_id: review.id,
          review_revision: review.revision
        }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }));
      expect(sender.calls).toEqual([]);
      await flushAgentCommunicationTestMessages(db);
      await dispatchFeishuOutbox({ config: config.integrations.feishu, database: db, sender });
      const outbox = listSyncOutbox(db, { source: "feishu" });

      expect(response.status).toBe(200);
      expect(sender.calls).toEqual([]);
      expect(outbox).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("router dispatches unlinked failed issue notifications to the default Feishu target", async () => {
    const db = await fixtureDatabase();
    const bus = new EventBus();
    const sender = new FakeFeishuSender();
    const config = buildConfig({
      feishuAppId: "cli_app_id",
      feishuAppSecret: "app-secret-value",
      feishuDefaultChatId: "oc_default"
    });
    try {
      const issue = createIssue(db, { project_id: "demo", title: "Needs human", status: "todo" });
      const router = createDefaultRouter({ bus, config, database: db, feishuSender: sender });

      const response = await router.handle(new Request(`${BASE_URL}/api/issues/${issue.id}`, {
        body: JSON.stringify({ error: "backend contract missing", status: "failed" }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      }));
      expect(sender.calls).toEqual([]);
      await flushAgentCommunicationTestMessages(db);
      await dispatchFeishuOutbox({ config: config.integrations.feishu, database: db, sender });
      const outbox = listSyncOutbox(db, { source: "feishu" });

      expect(response.status).toBe(200);
      expect(sender.calls).toEqual([{
        receiveId: "oc_default",
        receiveIdType: "chat_id",
        text: "玄武 Supervisor：issue #1 执行失败/阻塞：Needs human\n" +
          "错误摘要：backend contract missing\n" +
          "下一步：请查看 Runner issue #1 的日志，补充授权/信息后 retry 或重新排队。\n" +
          "查看：/api/issues/1"
      }]);
      expect(outbox[0]).toMatchObject({ feishu_message_id: "om_auto_sent_1", status: "sent" });
    } finally {
      db.close();
    }
  });

  test("queues one Feishu needs-user draft for a linked issue and dedupes repeats", async () => {
    const db = await fixtureDatabase();
    try {
      const issueID = linkedFeishuIssue(db);
      const event = {
        issueId: issueID,
        payload: JSON.stringify({
          action_id: "needs-user-action",
          diagnosis: "provider_auth_failed",
          message: "TOKEN=secret failed at /Users/xiaobei/app.ts\n    at leak (/tmp/stack.js:1)",
          next_step: "Refresh provider credentials and retry.",
          provider: "codex",
          user_facing_message: [
            "我检查了 issue #1 的真实执行状态，确认现在需要你介入。",
            "当前状态：issue=failed；run=failed，已结束；executor session=stopped。",
            "我暂时没有继续自动重试：重试不会刷新授权状态。"
          ].join("\n")
        }),
        projectId: "demo",
        type: "pi.needs_user"
      };

      const first = queueFeishuPiNeedsUserNotification(db, event);
      const second = queueFeishuPiNeedsUserNotification(db, event);
      await flushAgentCommunicationTestMessages(db);
      const outbox = listSyncOutbox(db, { source: "feishu" });
      const intents = listPiNotificationIntents(db, { issueId: issueID });
      const text = JSON.stringify({ intents, outbox });

      expect(first).toMatchObject({ queued: true, reason: "queued" });
      expect(second).toMatchObject({ queued: false, reason: "duplicate" });
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({
        content: expect.stringContaining("我检查了 issue #1 的真实执行状态"),
        issue_id: issueID,
        target_chat_id: "oc_group"
      });
      expect(intents).toMatchObject([
        expect.objectContaining({
          kind: "pi_needs_user",
          sent_outbox_id: outbox[0]?.id,
          state: "sent",
          target_channel: "feishu"
        })
      ]);
      expect(text).toContain("我暂时没有继续自动重试");
      expect(text).not.toContain("Provider：");
      expect(text).not.toContain("诊断：");
      expect(text).not.toContain("secret");
      expect(text).not.toContain("/Users/xiaobei");
      expect(text).not.toContain("at leak");
    } finally {
      db.close();
    }
  });

  test("immediately notifies the exact human review question instead of waiting for the 24h timeout", async () => {
    const db = await fixtureDatabase();
    const bus = new EventBus();
    try {
      const issueID = linkedFeishuIssue(db);
      updateIssue(db, issueID, { status: "pending_verification" });
      createDefaultRouter({ bus, database: db });
      const question = "是否接受 Node/TypeScript/PostgreSQL、OIDC、BlobStore、Provider 适配层、禁止 Mock，以及 V0.1 范围这些技术和产品取舍？";

      const request = createHumanReviewRequest(db, issueID, {
        excluded_scope: ["安装数据库", "启动完整程序"],
        kind: "decision",
        question,
        recommendation: "接受"
      }, { bus });
      await flushAgentCommunicationTestMessages(db);
      const outbox = listSyncOutbox(db, { source: "feishu" });
      const content = String(outbox[0]?.content);

      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({
        issue_id: issueID,
        target_chat_id: "oc_group"
      });
      expect(content).toContain(`你正在审批：${question}`);
      expect(content).toContain("不包含：安装数据库；启动完整程序");
      expect(listPiNotificationIntents(db, { issueId: issueID })).toMatchObject([
        expect.objectContaining({
          kind: "pi_needs_user",
          source_event_id: request.id,
          state: "sent"
        })
      ]);
    } finally {
      db.close();
    }
  });

  test("skips Feishu needs-user notification without a linked target", async () => {
    const db = await fixtureDatabase();
    try {
      const issue = createIssue(db, { project_id: "demo", title: "Unlinked task", status: "in_progress" });

      const result = queueFeishuPiNeedsUserNotification(db, {
        issueId: issue.id,
        payload: JSON.stringify({ action_id: "needs-user-unlinked", message: "Needs user" }),
        projectId: "demo",
        type: "pi.needs_user"
      });

      expect(result).toMatchObject({ queued: false, reason: "missing_feishu_target" });
      expect(listSyncOutbox(db, { source: "feishu" })).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("unlinked Feishu needs-user notifications fall back to the default target", async () => {
    const db = await fixtureDatabase();
    const config = buildConfig({ feishuDefaultChatId: "oc_default" });
    try {
      const issue = createIssue(db, { project_id: "demo", title: "Unlinked task", status: "in_progress" });

      const result = queueFeishuPiNeedsUserNotification(db, {
        issueId: issue.id,
        payload: JSON.stringify({ action_id: "needs-user-default", message: "Needs user" }),
        projectId: "demo",
        type: "pi.needs_user"
      }, { config: config.integrations.feishu });

      await flushAgentCommunicationTestMessages(db);
      const outbox = listSyncOutbox(db, { source: "feishu" });
      expect(result).toMatchObject({ queued: true, reason: "queued" });
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({
        content: expect.stringContaining("issue #1 需要用户介入"),
        issue_id: issue.id,
        target_chat_id: "oc_default"
      });
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
