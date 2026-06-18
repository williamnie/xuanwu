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
import { listPiGuardianEvents, listPiNotificationIntents } from "../db/repositories/pi.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { createBatchRunGroup, updateRunGroupEnqueueResult } from "../pi/runGroupService.ts";
import { queueFeishuIssueStatusNotification } from "./feishuLifecycleNotifications.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Feishu lifecycle notification intents", () => {
  test("legacy lifecycle notification writes inbox and intent before existing Feishu outbox", async () => {
    const db = await fixtureDatabase();
    try {
      const issueID = linkedFeishuIssue(db);
      updateIssue(db, issueID, { status: "done", error: "" });

      const result = queueFeishuIssueStatusNotification(db, issueID);
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
      expect(outbox[0]?.content).toContain("issue #1 已完成");
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
});

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-feishu-lifecycle-intent-"));
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
