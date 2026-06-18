import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createExternalEvent } from "../db/repositories/externalEvents.ts";
import { createExternalLink } from "../db/repositories/externalLinks.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { listSyncOutbox } from "../db/repositories/imReplyOutbox.ts";
import { createPiNotificationPreference, listPiNotificationIntents } from "../db/repositories/pi.ts";
import { queueFeishuIssueStatusNotification } from "./feishuLifecycleNotifications.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Feishu lifecycle notification preference routing", () => {
  test("quiet preference suppresses ordinary single issue lifecycle Feishu drafts", async () => {
    const db = await fixtureDatabase();
    try {
      createProjectPreference(db, "pref-project-quiet", "quiet");
      const issueID = linkedFeishuIssue(db);

      updateIssue(db, issueID, { status: "todo", error: "" });
      const start = queueFeishuIssueStatusNotification(db, issueID);
      updateIssue(db, issueID, { status: "done", error: "" });
      const done = queueFeishuIssueStatusNotification(db, issueID);

      expect(start).toMatchObject({ queued: false, reason: "run_group_lifecycle_suppressed" });
      expect(done).toMatchObject({ queued: false, reason: "run_group_lifecycle_suppressed" });
      expect(listSyncOutbox(db, { source: "feishu" })).toHaveLength(0);
      expect(listPiNotificationIntents(db, { issueId: issueID })).toEqual(expect.arrayContaining([
        expect.objectContaining({ decision: "suppress", kind: "issue_start", preference_id: "pref-project-quiet" }),
        expect.objectContaining({ decision: "suppress", kind: "issue_done", preference_id: "pref-project-quiet" })
      ]));
    } finally {
      db.close();
    }
  });

  test("digest preference aggregates ordinary single issue lifecycle without direct Feishu drafts", async () => {
    const db = await fixtureDatabase();
    try {
      createProjectPreference(db, "pref-project-digest", "digest");
      const issueID = linkedFeishuIssue(db);

      updateIssue(db, issueID, { status: "done", error: "" });
      const result = queueFeishuIssueStatusNotification(db, issueID);

      expect(result).toMatchObject({ queued: false, reason: "run_group_lifecycle_aggregated" });
      expect(listSyncOutbox(db, { source: "feishu" })).toHaveLength(0);
      expect(listPiNotificationIntents(db, { issueId: issueID })).toMatchObject([
        {
          decision: "aggregate",
          kind: "issue_done",
          preference_id: "pref-project-digest",
          run_group_id: "",
          state: "aggregated"
        }
      ]);
    } finally {
      db.close();
    }
  });

  test("normal preference preserves existing single issue Feishu routing", async () => {
    const db = await fixtureDatabase();
    try {
      createProjectPreference(db, "pref-project-normal", "normal");
      const issueID = linkedFeishuIssue(db);

      updateIssue(db, issueID, { status: "done", error: "" });
      const result = queueFeishuIssueStatusNotification(db, issueID);

      expect(result).toMatchObject({ queued: true, reason: "queued" });
      expect(listSyncOutbox(db, { source: "feishu" })).toHaveLength(1);
      expect(listPiNotificationIntents(db, { issueId: issueID })).toMatchObject([
        {
          decision: "send_now",
          kind: "issue_done",
          preference_id: "pref-project-normal",
          run_group_id: "",
          state: "sent"
        }
      ]);
    } finally {
      db.close();
    }
  });
});

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-feishu-lifecycle-pref-"));
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
    dedupe_key: `feishu:message:om_pref_${issue.id}`,
    external_id: `om_pref_${issue.id}`,
    normalized_message: { chat_id: "oc_group", message_id: `om_pref_${issue.id}` },
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

function createProjectPreference(db: RunnerDatabase, id: string, mode: string): void {
  createPiNotificationPreference(db, {
    effective_after_sequence: 0,
    id,
    mode,
    project_id: "demo",
    scope: "project"
  });
}
