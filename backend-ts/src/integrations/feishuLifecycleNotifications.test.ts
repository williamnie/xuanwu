import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createExternalEvent } from "../db/repositories/externalEvents.ts";
import { createExternalLink } from "../db/repositories/externalLinks.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { listSyncOutbox } from "../db/repositories/imReplyOutbox.ts";
import { createPiAction, listPiGuardianEvents, listPiNotificationIntents } from "../db/repositories/pi.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { flushAgentCommunicationTestMessages } from "../notifications/agentCommunicationGateway.testSupport.ts";
import { createBatchRunGroup, updateRunGroupEnqueueResult } from "../pi/runGroupService.ts";
import { buildFeishuConnectorConfig } from "./feishu.ts";
import { queueFeishuIssueStatusNotification } from "./feishuLifecycleNotifications.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Feishu lifecycle notification intents", () => {
  test("lets Agent consolidate legacy lifecycle events per conversation target", async () => {
    const db = await fixtureDatabase();
    try {
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
    } finally {
      db.close();
    }
  });

  test("legacy lifecycle notification writes inbox and intent before existing Feishu outbox", async () => {
    const db = await fixtureDatabase();
    try {
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
    } finally {
      db.close();
    }
  });

  test("legacy no-target lifecycle notifications are suppressed instead of left ready", async () => {
    const db = await fixtureDatabase();
    try {
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
    } finally {
      db.close();
    }
  });

  test("unlinked failed issues fall back to Feishu default target without enabling done spam", async () => {
    const db = await fixtureDatabase();
    try {
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
    } finally {
      db.close();
    }
  });

  test("unlinked project issues inherit the project-level Feishu conversation target", async () => {
    const db = await fixtureDatabase();
    try {
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
    } finally {
      db.close();
    }
  });

  test("legacy no-run-group terminal notification falls back to enqueue action conversation", async () => {
    const db = await fixtureDatabase();
    try {
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
    } finally {
      db.close();
    }
  });

  test("run group lifecycle writes aggregate intents without per-issue Feishu drafts", async () => {
    const db = await fixtureDatabase();
    try {
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
    } finally {
      db.close();
    }
  });

  test("legacy no-run-group send-now fallback coexists with run-group aggregation", async () => {
    const db = await fixtureDatabase();
    try {
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
    } finally {
      db.close();
    }
  });
});

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-feishu-lifecycle-intent-"));
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

function linkedFeishuIssue(db: RunnerDatabase, input: { conversationID?: string } = {}): number {
  const issue = createIssue(db, { project_id: "demo", title: "Feishu task", status: "triage" });
  const event = createExternalEvent(db, {
    content: "帮我修复问题",
    dedupe_key: `feishu:message:om_task_${issue.id}`,
    external_id: `om_task_${issue.id}`,
    normalized_message: { chat_id: "oc_group", message_id: `om_task_${issue.id}` },
    source: "feishu"
  });
  createExternalLink(db, {
    conversation_id: input.conversationID ?? "oc_group",
    external_event_id: event.id,
    external_type: "feishu_message",
    issue_id: issue.id,
    project_id: "demo",
    relationship: "created_issue",
    source: "feishu"
  });
  return issue.id;
}

function linkFeishuProject(db: RunnerDatabase, projectID: string, chatID: string): void {
  const event = createExternalEvent(db, {
    content: "项目通知路由",
    dedupe_key: `feishu:message:project_${projectID}`,
    external_id: `om_project_${projectID}`,
    normalized_message: { chat_id: chatID, message_id: `om_project_${projectID}` },
    source: "feishu"
  });
  createExternalLink(db, {
    conversation_id: chatID,
    external_event_id: event.id,
    external_type: "feishu_agent_reply",
    project_id: projectID,
    relationship: "agent_reply",
    source: "feishu"
  });
}

function legacyPiActionIssue(db: RunnerDatabase, actionID: string): number {
  const issue = createIssue(db, { project_id: "demo", title: "Legacy PI task", status: "todo" });
  createPiAction(db, {
    action_type: "issue.enqueue",
    conversation_id: "feishu-chat-oc_group-20260614",
    id: actionID,
    issue_id: issue.id,
    project_id: "demo",
    source: "feishu_runner_chat",
    status: "completed"
  });
  return issue.id;
}

function expectSendNowIntent(
  intents: ReturnType<typeof listPiNotificationIntents>,
  input: { issueID: number; kind: string }
): void {
  expect(intents).toEqual(expect.arrayContaining([
    expect.objectContaining({
      decision: "send_now",
      issue_id: input.issueID,
      kind: input.kind,
      run_group_id: "",
      state: "sent"
    })
  ]));
}
