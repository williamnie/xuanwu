import { expect, test } from "bun:test";
import { buildConfig } from "../../config/env.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { listSyncOutbox } from "../../db/repositories/imReplyOutbox.ts";
import { listPiNotificationIntents } from "../../db/repositories/pi.ts";
import { createIssueRun } from "../../db/repositories/issueRuns.ts";
import { updateIssue } from "../../db/repositories/issueUpdate.ts";
import { EventBus } from "../../events/bus.ts";
import { createHumanReviewRequest, reviewHumanIssue } from "../../domain/review/humanReview.ts";
import { createDefaultRouter } from "../../http/server.ts";
import { flushAgentCommunicationTestMessages } from "../../notifications/agentCommunicationGateway.testSupport.ts";
import { dispatchFeishuOutbox } from "./feishuOutboxDispatcherCompat.ts";
import { queueFeishuIssueStatusNotification, queueFeishuPiNeedsUserNotification } from "./feishuNotifications.ts";
import { observeGitHubIssue, updateGitHubIssueCase } from "../github/issueCaseStore.ts";
import type { TestFixture } from "./feishuNotifications.testFixture.ts";

export function registerFeedbackContinuationGetsItsOwnCases(testScope: TestFixture) {
  const { BASE_URL, pendingRequiredHandoffReview, fixtureDatabase, linkedFeishuIssue, FakeFeishuSender } = testScope;
  test("feedback continuation gets its own version-bound receipt after the original start and dedupes replay", async () => {
      const db = await fixtureDatabase();
      const issueID = linkedFeishuIssue(db);
      updateIssue(db, issueID, { status: "in_progress" });
      const run = createIssueRun(db, issueID);
      db.sqlite.run("update issue_runs set status='succeeded', ended_at='2026-09-29' where id=?", [run.id]);
      expect(queueFeishuIssueStatusNotification(db, issueID).queued).toBe(true);
      await flushAgentCommunicationTestMessages(db);
      updateIssue(db, issueID, { status: "needs_user" });
      const request = createHumanReviewRequest(db, issueID, { question: "确认仅本地交付？", kind: "decision" });
      await reviewHumanIssue(db, issueID, { action: "accept", comment: "同意", review_request_id: request.id, review_revision: request.revision });
      expect(queueFeishuIssueStatusNotification(db, issueID, { suppressDirectStart: true }).queued).toBe(true);
      await flushAgentCommunicationTestMessages(db);
      expect(queueFeishuIssueStatusNotification(db, issueID).queued).toBe(false);
      const outbox = listSyncOutbox(db, { source: "feishu" });
      expect(outbox).toHaveLength(2);
      const receipt = outbox.find(item => item.content.includes("反馈："))!;
      expect(receipt.content).toContain("已收到");
      expect(receipt.content).toContain(request.id);
      expect(receipt.content).toContain("版本 1");
      expect(receipt.content).toContain("尚未记录反馈后的新 Run");
      expect(receipt.content).not.toContain("已启动 executor session");
      expect(receipt.content).toContain(`#/work/${encodeURIComponent(`xw:work:issues:${issueID}`)}`);
    });
  
  test("old review notification cannot invite an answer to a superseded version", async () => {
      const db = await fixtureDatabase();
      const issueID = linkedFeishuIssue(db);
      updateIssue(db, issueID, { status: "needs_user" });
      const old = createHumanReviewRequest(db, issueID, { question: "旧问题" });
      createHumanReviewRequest(db, issueID, { question: "新问题" });
      expect(queueFeishuPiNeedsUserNotification(db, { issueId: issueID, type: "pi.needs_user", payload: JSON.stringify({ action_id: old.id, review_request_id: old.id, review_revision: old.revision }) })).toEqual({ queued: false, reason: "stale_review_request" });
      expect(listPiNotificationIntents(db, { issueId: issueID })).toHaveLength(0);
    });
  
  test("GitHub-managed human requests stay on GitHub unless Feishu was explicitly bound", async () => {
      const db = await fixtureDatabase();
      const issue = createIssue(db, { project_id: "demo", title: "GitHub task", status: "needs_user" });
      observeGitHubIssue(db, { nodeId: "I_notification", repositoryId: 1, repository: "acme/demo", number: 1,
        title: "GitHub task", body: "", author: "author", url: "https://github.com/acme/demo/issues/1", state: "open", stateReason: "", updatedAt: new Date().toISOString(), labels: ["xuanwu"] }, "demo");
      updateGitHubIssueCase(db, "I_notification", 1, { issue_id: issue.id, stage: "repair" });
      const config = buildConfig({ feishuDefaultChatId: "oc_default" }).integrations.feishu;
      const event = { issueId: issue.id, payload: JSON.stringify({ action_id: "github-human-request", message: "Needs decision" }), projectId: "demo", type: "pi.needs_user" };
      expect(queueFeishuPiNeedsUserNotification(db, event, { config })).toEqual({ queued: false, reason: "github_review_owns_target" });
      expect(listPiNotificationIntents(db, { issueId: issue.id })).toHaveLength(0);
      expect(listSyncOutbox(db, { source: "feishu" })).toHaveLength(0);
      config.projectMappings = [{ projectId: "demo", chatId: "oc_explicit" }];
      expect(queueFeishuPiNeedsUserNotification(db, event, { config })).toMatchObject({ queued: true });
      expect(listPiNotificationIntents(db, { issueId: issue.id })[0]?.target_chat_id).toBe("oc_explicit");
      const linkedID = linkedFeishuIssue(db);
      updateGitHubIssueCase(db, "I_notification", 1, { issue_id: linkedID });
      config.projectMappings = [];
      expect(queueFeishuPiNeedsUserNotification(db, { ...event, issueId: linkedID, payload: JSON.stringify({ action_id: "explicit-feishu-request", message: "Needs decision" }) }, { config })).toMatchObject({ queued: true });
      expect(listPiNotificationIntents(db, { issueId: linkedID })[0]?.target_chat_id).toBe("oc_group");
    });
  
  test("queues one approved Feishu outbox item when a linked issue is completed", async () => {
      const db = await fixtureDatabase();
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
        content: expect.stringContaining("#1「Feishu task」已结束"),
        issue_id: issueID,
        status: "pending",
        target_chat_id: "oc_group"
      });
    });
  
  test("router rejects direct done patches without a canonical Run and does not notify", async () => {
      const db = await fixtureDatabase();
      const bus = new EventBus();
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
    });
  
  test("human acceptance queues PI re-evaluation instead of declaring completion", async () => {
      const db = await fixtureDatabase();
      const bus = new EventBus();
      const issueID = linkedFeishuIssue(db);
      updateIssue(db, issueID, { error: "bun test passed", status: "needs_user" });
      const run = createIssueRun(db, issueID);
      db.sqlite.run("update issue_runs set status='succeeded', ended_at=? where id=?", [
        "2026-08-01T00:00:00Z", run.id
      ]);
      const review = pendingRequiredHandoffReview(db, issueID);
      const router = createDefaultRouter({ bus, database: db });
  
      const response = await router.handle(new Request(`${BASE_URL}/api/issues/${issueID}/human-review-response`, {
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
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.content).not.toContain("issue #1 已完成");
    });
  
  test("does not dispatch a completion notice before PI re-evaluates human acceptance", async () => {
      const db = await fixtureDatabase();
      const bus = new EventBus();
      const sender = new FakeFeishuSender();
      const config = buildConfig({ feishuAppId: "cli_app_id", feishuAppSecret: "app-secret-value" });
      const issueID = linkedFeishuIssue(db);
      updateIssue(db, issueID, { error: "bun test passed", status: "needs_user" });
      const run = createIssueRun(db, issueID);
      db.sqlite.run("update issue_runs set status='succeeded', ended_at=? where id=?", [
        "2026-08-01T00:00:00Z", run.id
      ]);
      const review = pendingRequiredHandoffReview(db, issueID);
      const router = createDefaultRouter({ bus, config, database: db, feishuSender: sender });
  
      const response = await router.handle(new Request(`${BASE_URL}/api/issues/${issueID}/human-review-response`, {
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
      expect(sender.calls).toHaveLength(1);
      expect(sender.calls[0]?.text).not.toContain("issue #1 已完成");
      expect(outbox).toHaveLength(1);
    });
  
  test("does not treat retired verifier metadata as a hidden notification carrier", async () => {
      const db = await fixtureDatabase();
      const issueID = linkedFeishuIssue(db);
      db.sqlite.run(
        "update issues set status='failed', workflow_snapshot_json=? where id=?",
        [JSON.stringify({ agent_role: "verifier", parent_issue_id: 815 }), issueID]
      );
  
      const result = queueFeishuIssueStatusNotification(db, issueID);
      await flushAgentCommunicationTestMessages(db);
  
      expect(result).toEqual({ queued: true, reason: "queued" });
      expect(listSyncOutbox(db, { source: "feishu" })).toHaveLength(1);
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
      const issue = createIssue(db, { project_id: "demo", title: "Needs human", status: "todo" });
      createDefaultRouter({ bus, config, database: db, feishuSender: sender });
      updateIssue(db, issue.id, { error: "backend contract missing", status: "failed" });
      const queued = queueFeishuIssueStatusNotification(db, issue.id, { config: config.integrations.feishu });
      expect(sender.calls).toEqual([]);
      await flushAgentCommunicationTestMessages(db);
      await dispatchFeishuOutbox({ config: config.integrations.feishu, database: db, sender });
      const outbox = listSyncOutbox(db, { source: "feishu" });
  
      expect(queued).toEqual({ queued: true, reason: "queued" });
      expect(sender.calls).toEqual([{
        receiveId: "oc_default",
        receiveIdType: "chat_id",
        text: "玄武 Supervisor：#1「Needs human」没有完成。\n" +
          "原因是：backend contract missing\n" +
          "请查看 #1 的执行记录；补齐授权或信息后再重试。\n" +
          "查看：#/work/xw%3Awork%3Aissues%3A1"
      }]);
      expect(outbox[0]).toMatchObject({ feishu_message_id: "om_auto_sent_1", status: "sent" });
    });
}
