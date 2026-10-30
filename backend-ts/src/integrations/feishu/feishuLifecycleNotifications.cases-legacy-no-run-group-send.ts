import { expect, test } from "bun:test";
import { getIssue } from "../../db/repositories/issues.ts";
import { listSyncOutbox } from "../../db/repositories/imReplyOutbox.ts";
import { listPiNotificationIntents } from "../../db/repositories/pi.ts";
import { updateIssue } from "../../db/repositories/issueUpdate.ts";
import { flushAgentCommunicationTestMessages } from "../../notifications/agentCommunicationGateway.testSupport.ts";
import { createBatchRunGroup, updateRunGroupEnqueueResult } from "../../pi/reports/runGroupService.ts";
import { queueFeishuIssueStatusNotification } from "./feishuLifecycleNotifications.ts";
import type { TestFixture } from "./feishuLifecycleNotifications.testFixture.ts";

export function registerLegacyNoRunGroupSendCases(testScope: TestFixture) {
  const { fixtureDatabase, linkedFeishuIssue } = testScope;
  test("legacy no-run-group send-now fallback coexists with run-group aggregation", async () => {
      const db = await fixtureDatabase();
      const legacyIssueID = linkedFeishuIssue(db);
      const groupedIssueID = linkedFeishuIssue(db, { conversationID: "feishu-chat-oc_group-20260614" });
      const groupedIssue = getIssue(db, groupedIssueID);
      if (!groupedIssue) throw new Error("missing grouped fixture issue");
      const group = createBatchRunGroup(db, {
        conversationID: "feishu-chat-oc_group-20260614",
        issues: [groupedIssue],
        projectID: "demo",
        userPhrase: "把这一批做完"
      });
      updateRunGroupEnqueueResult(db, group.id, groupedIssueID, "completed");
  
      updateIssue(db, legacyIssueID, { status: "done", error: "" });
      const legacy = queueFeishuIssueStatusNotification(db, legacyIssueID);
      updateIssue(db, groupedIssueID, { status: "done", error: "" });
      const grouped = queueFeishuIssueStatusNotification(db, groupedIssueID);
      await flushAgentCommunicationTestMessages(db);
  
      const legacyIntents = listPiNotificationIntents(db, { issueId: legacyIssueID });
      const groupedIntents = listPiNotificationIntents(db, { runGroupId: group.id });
  
      expect(legacy).toMatchObject({ queued: true, reason: "queued" });
      expect(grouped).toMatchObject({ queued: false, reason: "run_group_lifecycle_aggregated" });
      expect(listSyncOutbox(db, { source: "feishu" })).toHaveLength(1);
      expect(legacyIntents).toMatchObject([
        { decision: "send_now", issue_id: legacyIssueID, kind: "issue_done", run_group_id: "", state: "sent" }
      ]);
      expect(groupedIntents).toMatchObject([
        { decision: "aggregate", issue_id: groupedIssueID, kind: "issue_done", run_group_id: group.id, state: "aggregated" }
      ]);
    });
}
