import { expect, test } from "bun:test";
import { join } from "node:path";
import { buildConfig } from "../../config/env.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { listSyncOutbox } from "../../db/repositories/imReplyOutbox.ts";
import { listPiNotificationIntents } from "../../db/repositories/pi.ts";
import { getIssue, listIssueRuns } from "../../db/repositories/issues.ts";
import { updateIssue } from "../../db/repositories/issueUpdate.ts";
import { EventBus } from "../../events/bus.ts";
import { createHumanReviewRequest } from "../../domain/review/humanReview.ts";
import { createDefaultRouter } from "../../http/server.ts";
import { flushAgentCommunicationTestMessages } from "../../notifications/agentCommunicationGateway.testSupport.ts";
import { queueFeishuPiNeedsUserNotification } from "./feishuNotifications.ts";
import type { TestFixture } from "./feishuNotifications.testFixture.ts";

export function registerQueuesOneFeishuNeedsUserCases(testScope: TestFixture) {
  const { BASE_URL, fixtureDatabase, linkedFeishuIssue } = testScope;
  test("queues one Feishu needs-user draft for a linked issue and dedupes repeats", async () => {
      const db = await fixtureDatabase();
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
    });
  
  test("immediately notifies the exact human review question instead of waiting for the 24h timeout", async () => {
      const db = await fixtureDatabase();
      const bus = new EventBus();
      const issueID = linkedFeishuIssue(db);
      updateIssue(db, issueID, { status: "needs_user" });
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
      expect(content).toContain(`请求 ${request.id} · 版本 ${request.revision}`);
      expect(listPiNotificationIntents(db, { issueId: issueID })).toMatchObject([
        expect.objectContaining({
          kind: "pi_needs_user",
          source_event_id: request.id,
          state: "sent"
        })
      ]);
    });
  
  test("notifies the linked user when a managed executor is denied self-cancellation", async () => {
      const db = await fixtureDatabase();
      const bus = new EventBus();
      const issueID = linkedFeishuIssue(db);
      updateIssue(db, issueID, {
        codex_thread_id: "thread-self",
        codex_turn_id: "turn-self",
        status: "in_progress"
      });
      db.sqlite.run(
        `insert into issue_runs
          (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id, started_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
        ["issue-self-attempt-1", issueID, 1, "in_progress", "codex", "thread-self", "turn-self", "2026-01-01T00:00:00Z"]
      );
      const router = createDefaultRouter({ bus, database: db });
  
      const response = await router.handle(new Request(`${BASE_URL}/api/issues/${issueID}/cancel`, {
        body: "{}",
        headers: {
          "content-type": "application/json",
          "x-codex-client": "xuanwu-cli",
          "x-xuanwu-caller-thread-id": "thread-self",
          "x-xuanwu-managed-execution": "1"
        },
        method: "POST"
      }));
      await flushAgentCommunicationTestMessages(db);
      const outbox = listSyncOutbox(db, { source: "feishu" });
      const intents = listPiNotificationIntents(db, { issueId: issueID });
  
      expect(response.status).toBe(409);
      expect(getIssue(db, issueID)?.status).toBe("in_progress");
      expect(listIssueRuns(db, issueID).at(-1)).toMatchObject({ ended_at: "", status: "in_progress" });
      expect(intents).toContainEqual(expect.objectContaining({
        kind: "pi_needs_user",
        requires_user: 1,
        state: "sent",
        target_chat_id: "oc_group"
      }));
      expect(outbox).toContainEqual(expect.objectContaining({
        content: expect.stringContaining("已阻止 Issue #1 的 executor 修改自己的生命周期"),
        issue_id: issueID,
        target_chat_id: "oc_group"
      }));
    });
  
  test("skips Feishu needs-user notification without a linked target", async () => {
      const db = await fixtureDatabase();
      const issue = createIssue(db, { project_id: "demo", title: "Unlinked task", status: "in_progress" });
  
      const result = queueFeishuPiNeedsUserNotification(db, {
        issueId: issue.id,
        payload: JSON.stringify({ action_id: "needs-user-unlinked", message: "Needs user" }),
        projectId: "demo",
        type: "pi.needs_user"
      });
  
      expect(result).toMatchObject({ queued: false, reason: "missing_feishu_target" });
      expect(listSyncOutbox(db, { source: "feishu" })).toHaveLength(0);
    });
  
  test("unlinked Feishu needs-user notifications fall back to the default target", async () => {
      const db = await fixtureDatabase();
      const config = buildConfig({ feishuDefaultChatId: "oc_default" });
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
        content: expect.stringContaining("issue #1 现在需要你处理"),
        issue_id: issue.id,
        target_chat_id: "oc_default"
      });
    });
}
