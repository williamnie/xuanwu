import { expect, test } from "bun:test";
import { join } from "node:path";
import { listIssueEvents } from "../../db/repositories/issueEvents.ts";
import { getIssue } from "../../db/repositories/issues.ts";
import { listSyncOutbox } from "../../db/repositories/imReplyOutbox.ts";
import { createPiAction } from "../../db/repositories/pi.ts";
import { updateIssue } from "../../db/repositories/issueUpdate.ts";
import { EventBus } from "../../events/bus.ts";
import { flushAgentCommunicationTestMessages } from "../../notifications/agentCommunicationGateway.testSupport.ts";
import { runProjectLoopOnce } from "../../runner/projectLoop.ts";
import { attachFeishuNotificationObservers } from "./feishuNotifications.ts";
import type { TestFixture } from "./feishuNotificationLifecycle.testFixture.ts";

export function registerProjectLoopQueuesStartAndCases(testScope: TestFixture) {
  const { fixtureDatabase, failingProvider, linkedFeishuIssue } = testScope;
  test("project loop queues start and defers provider failure semantics to Supervisor", async () => {
      const db = await fixtureDatabase("fake-execution-only");
      const bus = new EventBus();
      const detach = attachFeishuNotificationObservers({ bus, database: db });
      try {
        linkedFeishuIssue(db);
        updateIssue(db, 1, { error: "", status: "todo" });
  
        const result = await runProjectLoopOnce({
          bus,
          database: db,
          projectId: "demo",
          providers: { "fake-execution-only": failingProvider() }
        });
  
        await flushAgentCommunicationTestMessages(db);
        const outbox = listSyncOutbox(db, { source: "feishu" });
        expect(result).toMatchObject({ claimed: true });
        expect(outbox).toHaveLength(1);
        expect(outbox.map((item) => item.content).join("\n")).toContain("已启动 executor session");
        expect(outbox.map((item) => item.content).join("\n")).not.toContain("执行失败/阻塞");
        expect(getIssue(db, 1)?.status).toBe("in_progress");
        expect(listIssueEvents(db, 1, { types: ["issue.pi_acceptance_requested.v1"] })).toHaveLength(1);
      } finally {
        detach();
        db.close();
      }
    });
  
  test("observer queues one PI action pending approval notification", async () => {
      const db = await fixtureDatabase();
      const bus = new EventBus();
      const detach = attachFeishuNotificationObservers({ bus, database: db });
      try {
        const issueID = linkedFeishuIssue(db, { conversationID: "feishu-chat-oc_group-20260614" });
        createPiAction(db, {
          action_type: "session.steer",
          conversation_id: "feishu-chat-oc_group-20260614",
          gate_decision: "ask",
          id: "pi-action-1",
          issue_id: issueID,
          project_id: "demo",
          source: "pi_tool",
          status: "pending"
        });
        const event = {
          conversationId: "feishu-chat-oc_group-20260614",
          issueId: issueID,
          payload: JSON.stringify({ action_id: "pi-action-1", action_type: "session.steer", status: "pending" }),
          projectId: "demo",
          type: "pi.action_pending"
        };
  
        bus.publish(event);
        bus.publish(event);
  
        await flushAgentCommunicationTestMessages(db);
        const outbox = listSyncOutbox(db, { source: "feishu" });
        expect(outbox).toHaveLength(1);
        expect(outbox[0]).toMatchObject({ target_chat_id: "oc_group" });
        expect(outbox[0]?.content).toContain("需要你确认");
        expect(outbox[0]?.content).toContain("pi-action-1");
      } finally {
        detach();
        db.close();
      }
    });
}
