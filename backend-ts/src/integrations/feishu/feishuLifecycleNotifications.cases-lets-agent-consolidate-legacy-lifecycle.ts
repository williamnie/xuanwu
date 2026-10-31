import { expect, test } from "bun:test";
import { join } from "node:path";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { getIssue } from "../../db/repositories/issues.ts";
import { listSyncOutbox } from "../../db/repositories/imReplyOutbox.ts";
import { listPiGuardianEvents, listPiNotificationIntents } from "../../db/repositories/pi.ts";
import { updateIssue } from "../../db/repositories/issueUpdate.ts";
import { flushAgentCommunicationTestMessages } from "../../notifications/agentCommunicationGateway.testSupport.ts";
import { createBatchRunGroup, updateRunGroupEnqueueResult } from "../../pi/reports/runGroupService.ts";
import { buildFeishuConnectorConfig } from "./feishu.ts";
import { queueFeishuIssueStatusNotification } from "./feishuLifecycleNotifications.ts";
import type { TestFixture } from "./feishuLifecycleNotifications.testFixture.ts";

export function registerLetsAgentConsolidateLegacyLifecycleCases(testScope: TestFixture) {
  const { fixtureDatabase, linkedFeishuIssue, linkFeishuProject, legacyPiActionIssue, expectSendNowIntent } = testScope;
  test("lets Agent consolidate legacy lifecycle events per conversation target", async () => {
      const db = await fixtureDatabase();
      const issueID = linkedFeishuIssue(db);
      updateIssue(db, issueID, { status: "todo", error: "" });
      const start = queueFeishuIssueStatusNotification(db, issueID);
      updateIssue(db, issueID, { status: "done", error: "focused verification passed" });
      const done = queueFeishuIssueStatusNotification(db, issueID);
  
      const failedIssueID = linkedFeishuIssue(db);
      updateIssue(db, failedIssueID, { status: "failed", error: "tests failed" });
      const failed = queueFeishuIssueStatusNotification(db, failedIssueID);
  
      await flushAgentCommunicationTestMessages(db);
      const intents = listPiNotificationIntents(db);
      const outbox = listSyncOutbox(db, { source: "feishu" });
      const content = outbox.map((item) => item.content).join("\n");
  
      expect(start).toMatchObject({ queued: true, reason: "queued" });
      expect(done).toMatchObject({ queued: true, reason: "queued" });
      expect(failed).toMatchObject({ queued: true, reason: "queued" });
      expect(outbox).toHaveLength(1);
      expect(content).toContain("准备启动");
      expect(content).toContain("已结束");
      expect(content).toContain("没有完成");
      expectSendNowIntent(intents, { issueID, kind: "issue_start" });
      expectSendNowIntent(intents, { issueID, kind: "issue_done" });
      expectSendNowIntent(intents, { issueID: failedIssueID, kind: "issue_failed" });
    });
  
  test("legacy lifecycle notification writes inbox and intent before existing Feishu outbox", async () => {
      const db = await fixtureDatabase();
      const issueID = linkedFeishuIssue(db);
      updateIssue(db, issueID, { status: "done", error: "" });
  
      const result = queueFeishuIssueStatusNotification(db, issueID);
      await flushAgentCommunicationTestMessages(db);
      const intents = listPiNotificationIntents(db, { issueId: issueID });
      const inbox = listPiGuardianEvents(db, { issueId: issueID });
      const outbox = listSyncOutbox(db, { source: "feishu" });
  
      expect(result).toMatchObject({ queued: true, reason: "queued" });
      expect(inbox).toMatchObject([
        { event_type: "issue.status_changed", issue_id: issueID, run_group_id: "" }
      ]);
      expect(intents).toMatchObject([
        {
          decision: "send_now",
          issue_id: issueID,
          kind: "issue_done",
          run_group_id: "",
          sent_outbox_id: outbox[0]?.id,
          state: "sent"
        }
      ]);
      expect(intents[0]?.source_event_sequence_id).toBe(inbox[0]?.sequence_id);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.content).toContain("#1「Feishu task」已结束");
    });
  
  test("legacy no-target lifecycle notifications are suppressed instead of left ready", async () => {
      const db = await fixtureDatabase();
      const startIssue = createIssue(db, { project_id: "demo", title: "Unlinked PI task", status: "todo" });
      const doneIssue = createIssue(db, { project_id: "demo", title: "Unlinked PI done", status: "done" });
  
      const start = queueFeishuIssueStatusNotification(db, startIssue.id);
      const done = queueFeishuIssueStatusNotification(db, doneIssue.id);
      const startIntents = listPiNotificationIntents(db, { issueId: startIssue.id });
      const doneIntents = listPiNotificationIntents(db, { issueId: doneIssue.id });
  
      expect(start).toMatchObject({ queued: false, reason: "missing_feishu_link" });
      expect(done).toMatchObject({ queued: false, reason: "missing_feishu_link" });
      expect(listSyncOutbox(db, { source: "feishu" })).toHaveLength(0);
      expect(startIntents).toMatchObject([
        expect.objectContaining({
          decision: "suppress",
          error: "missing_feishu_link",
          issue_id: startIssue.id,
          kind: "issue_start",
          state: "suppressed"
        })
      ]);
      expect(doneIntents).toMatchObject([
        expect.objectContaining({
          decision: "suppress",
          error: "missing_feishu_link",
          issue_id: doneIssue.id,
          kind: "issue_done",
          state: "suppressed"
        })
      ]);
    });
  
  test("unlinked failed issues fall back to Feishu default target without enabling done spam", async () => {
      const db = await fixtureDatabase();
      const config = buildFeishuConnectorConfig({ defaultChatId: "oc_default" });
      const failedIssue = createIssue(db, { project_id: "demo", title: "Needs human", status: "todo" });
      const doneIssue = createIssue(db, { project_id: "demo", title: "Ordinary done", status: "done" });
      updateIssue(db, failedIssue.id, { error: "backend contract missing", status: "failed" });
  
      const failed = queueFeishuIssueStatusNotification(db, failedIssue.id, { config });
      const done = queueFeishuIssueStatusNotification(db, doneIssue.id, { config });
      await flushAgentCommunicationTestMessages(db);
      const intents = listPiNotificationIntents(db, { issueId: failedIssue.id });
      const outbox = listSyncOutbox(db, { source: "feishu" });
  
      expect(failed).toMatchObject({ queued: true, reason: "queued" });
      expect(done).toMatchObject({ queued: false, reason: "missing_feishu_link" });
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({
        issue_id: failedIssue.id,
        target_chat_id: "oc_default"
      });
      expect(outbox[0]?.content).toContain("没有完成");
      expect(intents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          decision: "send_now",
          kind: "issue_failed",
          severity: "needs_user",
          state: "sent"
        })
      ]));
    });
  
  test("unlinked project issues inherit the project-level Feishu conversation target", async () => {
      const db = await fixtureDatabase();
      linkFeishuProject(db, "demo", "oc_project");
      const issue = createIssue(db, { project_id: "demo", title: "Project-routed task", status: "todo" });
      updateIssue(db, issue.id, { error: "needs configuration", status: "failed" });
  
      const result = queueFeishuIssueStatusNotification(db, issue.id);
      await flushAgentCommunicationTestMessages(db);
      const outbox = listSyncOutbox(db, { source: "feishu" });
  
      expect(result).toMatchObject({ queued: true, reason: "queued" });
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({
        issue_id: issue.id,
        target_chat_id: "oc_project"
      });
      expect(listPiNotificationIntents(db, { issueId: issue.id })).toEqual([
        expect.objectContaining({
          decision: "send_now",
          error: "",
          state: "sent",
          target_chat_id: "oc_project"
        })
      ]);
    });
  
  test("legacy no-run-group terminal notification falls back to enqueue action conversation", async () => {
      const db = await fixtureDatabase();
      const doneIssueID = legacyPiActionIssue(db, "legacy-enqueue-done");
      const failedIssueID = legacyPiActionIssue(db, "legacy-enqueue-failed");
      updateIssue(db, doneIssueID, { status: "done", error: "legacy done" });
      updateIssue(db, failedIssueID, { status: "failed", error: "legacy failed" });
  
      const done = queueFeishuIssueStatusNotification(db, doneIssueID);
      const failed = queueFeishuIssueStatusNotification(db, failedIssueID);
      await flushAgentCommunicationTestMessages(db);
      const outbox = listSyncOutbox(db, { source: "feishu" });
      const content = outbox.map((item) => item.content).join("\n");
  
      expect(done).toMatchObject({ queued: true, reason: "queued" });
      expect(failed).toMatchObject({ queued: true, reason: "queued" });
      expect(outbox).toHaveLength(1);
      expect(outbox.map((item) => item.target_chat_id)).toEqual(["oc_group"]);
      expect(content).toContain("已结束");
      expect(content).toContain("没有完成");
      expectSendNowIntent(listPiNotificationIntents(db, { issueId: doneIssueID }), {
        issueID: doneIssueID,
        kind: "issue_done"
      });
      expectSendNowIntent(listPiNotificationIntents(db, { issueId: failedIssueID }), {
        issueID: failedIssueID,
        kind: "issue_failed"
      });
    });
  
  test("run group lifecycle writes aggregate intents without per-issue Feishu drafts", async () => {
      const db = await fixtureDatabase();
      const issueID = linkedFeishuIssue(db, { conversationID: "feishu-chat-oc_group-20260614" });
      const issue = getIssue(db, issueID);
      if (!issue) throw new Error("missing fixture issue");
      const group = createBatchRunGroup(db, {
        conversationID: "feishu-chat-oc_group-20260614",
        issues: [issue],
        projectID: "demo",
        userPhrase: "把这一批做完"
      });
      updateRunGroupEnqueueResult(db, group.id, issueID, "completed");
  
      updateIssue(db, issueID, { status: "todo", error: "" });
      const start = queueFeishuIssueStatusNotification(db, issueID);
      updateIssue(db, issueID, { status: "done", error: "" });
      const done = queueFeishuIssueStatusNotification(db, issueID);
      const intents = listPiNotificationIntents(db, { runGroupId: group.id });
      const inbox = listPiGuardianEvents(db, { runGroupId: group.id });
  
      expect(start).toMatchObject({ queued: false, reason: "run_group_lifecycle_suppressed" });
      expect(done).toMatchObject({ queued: false, reason: "run_group_lifecycle_aggregated" });
      expect(listSyncOutbox(db, { source: "feishu" })).toHaveLength(0);
      expect(intents).toEqual(expect.arrayContaining([
        expect.objectContaining({ decision: "suppress", kind: "issue_start", state: "suppressed" }),
        expect.objectContaining({ decision: "aggregate", kind: "issue_done", state: "aggregated" })
      ]));
      expect(intents.map((intent) => intent.run_group_id)).toEqual([group.id, group.id]);
      expect(inbox.map((event) => event.run_group_id)).toEqual([group.id, group.id]);
    });
}
