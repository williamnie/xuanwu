import { expect, test } from "bun:test";
import { join } from "node:path";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { listSyncOutbox } from "../../db/repositories/imReplyOutbox.ts";
import { createPiAction } from "../../db/repositories/pi.ts";
import { getProject } from "../../db/repositories/projects.ts";
import { updateIssue } from "../../db/repositories/issueUpdate.ts";
import { EventBus } from "../../events/bus.ts";
import { flushAgentCommunicationTestMessages } from "../../notifications/agentCommunicationGateway.testSupport.ts";
import { createPiRunnerActions } from "../../pi/runnerTools/runnerActions.ts";
import { attachFeishuNotificationObservers, queueFeishuIssueStatusNotification } from "./feishuNotifications.ts";
import type { TestFixture } from "./feishuNotificationLifecycle.testFixture.ts";

export function registerRoutesAnIssueLifecycleNotificationCases(testScope: TestFixture) {
  const { fixtureDatabase, linkedFeishuIssue, linkedTelegramIssue, createCandidate, memoryCandidateEvent } = testScope;
  test("routes an issue lifecycle notification back to its Telegram topic", async () => {
      const db = await fixtureDatabase();
      try {
        const issueID = linkedTelegramIssue(db);
        updateIssue(db, issueID, { status: "done", error: "" });
  
        const result = queueFeishuIssueStatusNotification(db, issueID);
        await flushAgentCommunicationTestMessages(db);
        const outbox = listSyncOutbox(db, { source: "telegram" });
  
        expect(result).toMatchObject({ queued: true, reason: "queued" });
        expect(outbox).toHaveLength(1);
        expect(outbox[0]).toMatchObject({
          target_chat_id: "-100123",
          target_message_id: "77",
          target_thread_id: "9"
        });
        expect(outbox[0]?.content).toContain("已结束");
      } finally {
        db.close();
      }
    });
  
  test("queues one start notification across todo and in-progress status replays", async () => {
      const db = await fixtureDatabase();
      try {
        const issueID = linkedFeishuIssue(db);
        updateIssue(db, issueID, { status: "todo", error: "" });
  
        const todo = queueFeishuIssueStatusNotification(db, issueID);
        updateIssue(db, issueID, { status: "in_progress", error: "" });
        const inProgress = queueFeishuIssueStatusNotification(db, issueID);
        const replay = queueFeishuIssueStatusNotification(db, issueID);
        await flushAgentCommunicationTestMessages(db);
        const outbox = listSyncOutbox(db, { source: "feishu" });
  
        expect(todo).toMatchObject({ queued: true, reason: "queued" });
        expect(inProgress).toMatchObject({ queued: false, reason: "duplicate" });
        expect(replay).toMatchObject({ queued: false, reason: "duplicate" });
        expect(outbox).toHaveLength(1);
        expect(outbox[0]?.content).toContain("准备启动");
        expect(outbox[0]?.content).toContain("#1「Feishu task」");
      } finally {
        db.close();
      }
    });
  
  test("redacts failed notification details and includes an actionable next step", async () => {
      const db = await fixtureDatabase();
      try {
        const issueID = linkedFeishuIssue(db);
        updateIssue(db, issueID, {
          status: "failed",
          error: "Error: token=fixture-secret at /Users/example/private.ts\n    at run (/Users/example/app.ts:1:1)"
        });
  
        const result = queueFeishuIssueStatusNotification(db, issueID);
        await flushAgentCommunicationTestMessages(db);
        const content = listSyncOutbox(db, { source: "feishu" })[0]?.content ?? "";
  
        expect(result).toMatchObject({ queued: true, reason: "queued" });
        expect(content).toContain("没有完成");
        expect(content).toContain("请查看 #1 的执行记录");
        expect(content).toContain("[redacted]");
        expect(content).not.toContain("fixture-secret");
        expect(content).not.toContain("/Users/example");
        expect(content).not.toContain("at run");
      } finally {
        db.close();
      }
    });
  
  test("observer uses PI action conversation as the start target and reuses it for completion", async () => {
      const db = await fixtureDatabase();
      const bus = new EventBus();
      const detach = attachFeishuNotificationObservers({ bus, database: db });
      try {
        const issue = createIssue(db, { project_id: "demo", title: "PI issue", status: "todo" });
  
        bus.publish({
          conversationId: "feishu-chat-oc_group-20260614",
          issueId: issue.id,
          payload: JSON.stringify({ action_id: "pi-enqueue-1", action_type: "issue.enqueue", status: "completed" }),
          projectId: "demo",
          type: "pi.action_completed"
        });
        updateIssue(db, issue.id, { error: "", status: "done" });
        bus.publish({ issueId: issue.id, payload: JSON.stringify({ status: "done" }), projectId: "demo", type: "issue.status_changed" });
  
        await flushAgentCommunicationTestMessages(db);
        const outbox = listSyncOutbox(db, { source: "feishu" });
        expect(outbox).toHaveLength(1);
        expect(outbox.map((item) => item.target_chat_id)).toEqual(["oc_group"]);
        expect(outbox.map((item) => item.content).join("\n")).toContain("准备启动");
        expect(outbox.map((item) => item.content).join("\n")).toContain("已结束");
      } finally {
        detach();
        db.close();
      }
    });
  
  test("observer lets PI summarize auto-executed runner chat enqueue actions instead of sending per-issue start notifications", async () => {
      const db = await fixtureDatabase();
      const bus = new EventBus();
      const detach = attachFeishuNotificationObservers({ bus, database: db });
      try {
        const first = createIssue(db, { project_id: "demo", title: "Batch A", status: "triage" });
        createIssue(db, { project_id: "demo", title: "Batch B", status: "triage" });
        createIssue(db, { project_id: "demo", title: "Batch C", status: "triage" });
        const project = getProject(db, "demo");
        if (!project) throw new Error("missing fixture project");
        const actions = createPiRunnerActions(db, {
          bus,
          conversationID: "feishu-chat-oc_group-20260614",
          project,
          source: "feishu_runner_chat"
        });
  
        const result = actions.enqueueBatchTriageIssues({ user_phrase: "把剩下的 issue 都开始" }) as {
          enqueued_count: number;
          status: string;
        };
  
        expect(result).toMatchObject({ enqueued_count: 3, status: "completed" });
        expect(listSyncOutbox(db, { source: "feishu" })).toHaveLength(0);
  
        updateIssue(db, first.id, { error: "", status: "in_progress" });
        bus.publish({ issueId: first.id, payload: JSON.stringify({ status: "in_progress" }), projectId: "demo", type: "issue.status_changed" });
  
        expect(listSyncOutbox(db, { source: "feishu" })).toHaveLength(0);
      } finally {
        detach();
        db.close();
      }
    });
  
  test("observer still sends start notifications for approved non-runner-chat enqueue actions", async () => {
      const db = await fixtureDatabase();
      const bus = new EventBus();
      const detach = attachFeishuNotificationObservers({ bus, database: db });
      try {
        const issueID = linkedFeishuIssue(db);
        updateIssue(db, issueID, { status: "todo", error: "" });
        createPiAction(db, {
          action_type: "issue.enqueue",
          gate_decision: "ask",
          id: "manual-approved-enqueue",
          issue_id: issueID,
          project_id: "demo",
          source: "pi_tool",
          status: "completed"
        });
  
        bus.publish({
          conversationId: "feishu-chat-oc_group-20260614",
          issueId: issueID,
          payload: JSON.stringify({ action_id: "manual-approved-enqueue", action_type: "issue.enqueue", status: "completed" }),
          projectId: "demo",
          type: "pi.action_completed"
        });
  
        await flushAgentCommunicationTestMessages(db);
        const outbox = listSyncOutbox(db, { source: "feishu" });
        expect(outbox).toHaveLength(1);
        expect(outbox[0]?.content).toContain("准备启动");
      } finally {
        detach();
        db.close();
      }
    });
  
  test("observer ignores retired memory candidate notifications", async () => {
      const db = await fixtureDatabase();
      const bus = new EventBus();
      const detach = attachFeishuNotificationObservers({ bus, database: db });
      try {
        createCandidate(db, "22345678-2222-4222-8222-123456789abc", "通知使用短句");
  
        bus.publish(memoryCandidateEvent("22345678-2222-4222-8222-123456789abc"));
  
        await flushAgentCommunicationTestMessages(db);
        const outbox = listSyncOutbox(db, { source: "feishu" });
        expect(outbox).toHaveLength(0);
      } finally {
        detach();
        db.close();
      }
    });
}
