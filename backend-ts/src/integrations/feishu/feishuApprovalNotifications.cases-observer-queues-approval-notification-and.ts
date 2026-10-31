import { expect, test } from "bun:test";
import { join } from "node:path";
import { listSyncOutbox } from "../../db/repositories/imReplyOutbox.ts";
import { listPiNotificationIntents } from "../../db/repositories/pi.ts";
import { upsertAgentSession } from "../../db/repositories/agentSessions.ts";
import { updateIssue } from "../../db/repositories/issueUpdate.ts";
import { EventBus } from "../../events/bus.ts";
import { flushAgentCommunicationTestMessages } from "../../notifications/agentCommunicationGateway.testSupport.ts";
import { buildFeishuConnectorConfig } from "./feishu.ts";
import { attachFeishuNotificationObservers, getPiApprovalRequest } from "./feishuNotifications.ts";
import type { TestFixture } from "./feishuApprovalNotifications.testFixture.ts";

export function registerObserverQueuesApprovalNotificationAndCases(testScope: TestFixture) {
  const { fixtureDatabase, linkedFeishuIssue, approvalEvent } = testScope;
  test("observer queues approval notification and records resolved provider event", async () => {
      const db = await fixtureDatabase();
      const bus = new EventBus();
      const detach = attachFeishuNotificationObservers({
        bus,
        config: buildFeishuConnectorConfig({ appId: "cli_app_id", appSecret: "app-secret-value" }),
        database: db,
        sender: {
          sendTextMessage: async () => ({ messageId: "om_sent_text" }),
          sendInteractiveCard: async () => ({ messageId: "om_sent_card" })
        }
      });
      try {
        const issueID = linkedFeishuIssue(db);
        upsertAgentSession(db, { issue_id: issueID, project_id: "demo", provider: "codex", provider_session_id: "thread-observed" });
        updateIssue(db, issueID, { status: "done", error: "" });
  
        bus.publish({ issueId: issueID, payload: JSON.stringify({ status: "done" }), type: "issue.status_changed" });
        bus.publish(approvalEvent("approval-observed", "thread-observed", "bun test"));
        bus.publish({
          method: "approval/resolved",
          payload: JSON.stringify({ decision: "deny", id: "approval-observed", scope: "turn" }),
          provider: "codex",
          threadId: "thread-observed",
          type: "codex.event"
        });
  
        await flushAgentCommunicationTestMessages(db);
        const outbox = listSyncOutbox(db, { source: "feishu" });
        expect(outbox).toHaveLength(1);
        expect(outbox.map((item) => item.content).join("\n")).toContain("#1「Feishu task」已结束");
        expect(outbox.map((item) => item.content).join("\n")).not.toContain("bun test");
        expect(listPiNotificationIntents(db, { issueId: issueID })).toEqual(expect.arrayContaining([
          expect.objectContaining({
            error: "action_no_longer_pending",
            kind: "approval_requested",
            state: "suppressed"
          })
        ]));
        expect(getPiApprovalRequest(db, "approval-observed")).toMatchObject({ resolved_decision: "deny", status: "rejected" });
      } finally {
        detach();
        db.close();
      }
    });
}
