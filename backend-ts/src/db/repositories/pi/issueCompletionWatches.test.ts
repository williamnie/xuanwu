import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../database.ts";
import { createIssue } from "../issueCreate.ts";
import {
  cancelPiIssueCompletionWatch,
  createPiIssueCompletionWatch,
  getPiIssueCompletionWatch,
  listActivePiIssueCompletionWatches,
  markPiIssueCompletionWatchNotified,
  markPiIssueCompletionWatchSatisfied,
  updatePiIssueCompletionWatchItemStatus
} from "../pi.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI issue completion watches", () => {
  test("creates active watches with item status snapshots and lists active rows", async () => {
    const db = await openFixtureDatabase();
    try {
      const first = createIssue(db, { project_id: "demo", title: "A", status: "todo" });
      const second = createIssue(db, { project_id: "demo", title: "B", status: "in_progress" });

      const watch = createPiIssueCompletionWatch(db, {
        issue_ids: [first.id, second.id],
        origin_conversation_id: "feishu-chat-oc_group-20260629",
        project_id: "demo",
        requested_by: "ou_user",
        source_event_id: "feishu-event-1",
        source_message_id: "om_source",
        target_channel: "feishu",
        target_chat_id: "oc_group",
        target_message_id: "om_source"
      });

      expect(watch).toMatchObject({
        origin_conversation_id: "feishu-chat-oc_group-20260629",
        project_id: "demo",
        requested_by: "ou_user",
        status: "active",
        target_chat_id: "oc_group"
      });
      expect(JSON.parse(watch.condition)).toMatchObject({ pending_verification_satisfies: true });
      expect(watch.items).toMatchObject([
        { initial_status: "todo", issue_id: first.id, last_status: "todo", project_id: "demo", terminal_at: "" },
        { initial_status: "in_progress", issue_id: second.id, last_status: "in_progress", project_id: "demo", terminal_at: "" }
      ]);
      expect(listActivePiIssueCompletionWatches(db).map((item) => item.id)).toEqual([watch.id]);
    } finally {
      db.close();
    }
  });

  test("dedupes the same source event, target, and issue set while active", async () => {
    const db = await openFixtureDatabase();
    try {
      const first = createIssue(db, { project_id: "demo", title: "A", status: "todo" });
      const second = createIssue(db, { project_id: "demo", title: "B", status: "todo" });
      const input = {
        issue_ids: [first.id, second.id],
        project_id: "demo",
        source_event_id: "event-same",
        target_channel: "feishu",
        target_chat_id: "oc_group",
        target_message_id: "om_root"
      };

      const watch = createPiIssueCompletionWatch(db, input);
      const duplicate = createPiIssueCompletionWatch(db, {
        ...input,
        id: "different-id",
        issue_ids: [second.id, first.id]
      });

      expect(duplicate.id).toBe(watch.id);
      expect(listActivePiIssueCompletionWatches(db)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("updates item terminal status and satisfies after all watched issues finish", async () => {
    const db = await openFixtureDatabase();
    try {
      const first = createIssue(db, { project_id: "demo", title: "A", status: "todo" });
      const second = createIssue(db, { project_id: "demo", title: "B", status: "todo" });
      const watch = createPiIssueCompletionWatch(db, {
        issue_ids: [first.id, second.id],
        project_id: "demo",
        source_event_id: "event-finish",
        target_channel: "feishu",
        target_chat_id: "oc_group"
      });

      updatePiIssueCompletionWatchItemStatus(db, watch.id, first.id, "pending_verification");
      const waiting = getPiIssueCompletionWatch(db, watch.id);
      expect(waiting?.status).toBe("active");
      expect(waiting?.items.find((item) => item.issue_id === first.id))
        .toMatchObject({ issue_id: first.id, last_status: "pending_verification" });

      const terminalItem = updatePiIssueCompletionWatchItemStatus(db, watch.id, second.id, "failed");
      const satisfied = markPiIssueCompletionWatchSatisfied(db, watch.id);

      expect(terminalItem).toMatchObject({ issue_id: second.id, last_status: "failed" });
      expect(terminalItem.terminal_at).not.toBe("");
      expect(satisfied).toMatchObject({ completed_at: expect.any(String), status: "satisfied" });
      expect(listActivePiIssueCompletionWatches(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("marks notified and cancels active watches", async () => {
    const db = await openFixtureDatabase();
    try {
      const first = createIssue(db, { project_id: "demo", title: "A", status: "todo" });
      const satisfied = createPiIssueCompletionWatch(db, {
        issue_ids: [first.id],
        project_id: "demo",
        source_event_id: "event-notified",
        target_channel: "feishu",
        target_chat_id: "oc_group"
      });
      updatePiIssueCompletionWatchItemStatus(db, satisfied.id, first.id, "done");

      expect(markPiIssueCompletionWatchNotified(db, satisfied.id)).toMatchObject({
        notified_at: expect.any(String),
        status: "notified"
      });

      const second = createIssue(db, { project_id: "demo", title: "B", status: "todo" });
      const active = createPiIssueCompletionWatch(db, {
        issue_ids: [second.id],
        project_id: "demo",
        source_event_id: "event-cancel",
        target_channel: "feishu",
        target_chat_id: "oc_group"
      });

      expect(cancelPiIssueCompletionWatch(db, active.id, "user_cancel")).toMatchObject({
        error: "user_cancel",
        status: "cancelled"
      });
      expect(listActivePiIssueCompletionWatches(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-issue-watch-"));
  tempRoots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, provider_config_json, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["demo", "Demo", join(root, "project"), "codex", '{"capabilities":["issue_execution"]}', 1,
      "2026-06-29T00:00:00Z", "2026-06-29T00:00:00Z"]
  );
  return db;
}
