import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../database.ts";
import {
  addPiRunGroupItem,
  createPiGuardianEvent,
  createPiNotificationIntent,
  createPiRunGroup,
  getPiGuardianEvent,
  getPiNotificationIntent,
  getPiRunGroup,
  listPiGuardianEvents,
  listPiNotificationIntents,
  listPiRunGroupItems,
  listPiRunGroups,
  refreshPiRunGroupCompletion,
  updatePiGuardianEvent,
  updatePiNotificationIntent,
  updatePiRunGroup,
  updatePiRunGroupItem
} from "../pi.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI Guardian runtime repositories", () => {
  test("creates event inbox rows idempotently with DB monotonic sequence ids", async () => {
    const db = await openFixtureDatabase();
    try {
      const first = createPiGuardianEvent(db, {
        id: "event-1",
        source: "issue_events",
        source_event_id: "issue_event:1",
        event_type: "issue.status_changed",
        project_id: "demo",
        issue_id: 101,
        idempotency_key: "issue.status_changed:demo:101:issue_event:1",
        normalized_payload_json: { status: "in_progress" }
      });
      const duplicate = createPiGuardianEvent(db, {
        id: "event-1-duplicate",
        source: "issue_events",
        source_event_id: "issue_event:1",
        event_type: "issue.status_changed",
        project_id: "demo",
        issue_id: 101,
        idempotency_key: "issue.status_changed:demo:101:issue_event:1"
      });
      const second = createPiGuardianEvent(db, {
        id: "event-2",
        source: "scheduler",
        source_event_id: "tick:1",
        event_type: "digest.flush_due",
        project_id: "demo",
        run_group_id: "group-1",
        idempotency_key: "digest.flush_due:demo:group-1:tick:1"
      });
      const consumed = updatePiGuardianEvent(db, first.id, {
        status: "consumed",
        consumed_at: "2026-06-18T00:00:00Z"
      });

      expect(first.sequence_id).toBeGreaterThan(0);
      expect(duplicate.sequence_id).toBe(first.sequence_id);
      expect(second.sequence_id).toBeGreaterThan(first.sequence_id);
      expect(consumed).toMatchObject({ id: "event-1", status: "consumed", consumed_at: "2026-06-18T00:00:00Z" });
      expect(getPiGuardianEvent(db, "event-1")).toMatchObject({ normalized_payload_json: "{\"status\":\"in_progress\"}" });
      expect(listPiGuardianEvents(db, { projectId: "demo" }).map((event) => event.id)).toEqual(["event-1", "event-2"]);
    } finally {
      db.close();
    }
  });

  test("creates and updates run groups with reportable group items", async () => {
    const db = await openFixtureDatabase();
    try {
      insertIssue(db, 101, "Implement A");
      insertIssue(db, 102, "Implement B");
      insertIssue(db, 103, "Implement C");

      const group = createPiRunGroup(db, {
        id: "group-1",
        project_id: "demo",
        origin_conversation_id: "conv-1",
        user_phrase: "把剩下都做完",
        expected_issue_count: 3,
        deadline_at: "2026-06-19T00:00:00Z"
      });
      const duplicateGroup = createPiRunGroup(db, { id: "group-1", project_id: "demo", expected_issue_count: 99 });
      addPiRunGroupItem(db, {
        run_group_id: group.id,
        issue_id: 101,
        position: 1,
        issue_title_snapshot: "Implement A",
        enqueue_status: "completed"
      });
      addPiRunGroupItem(db, {
        run_group_id: group.id,
        issue_id: 102,
        position: 2,
        issue_title_snapshot: "Implement B",
        enqueue_status: "failed",
        report_reason: "enqueue rejected"
      });
      addPiRunGroupItem(db, {
        run_group_id: group.id,
        issue_id: 102,
        position: 2,
        issue_title_snapshot: "Implement B",
        enqueue_status: "failed",
        report_reason: "enqueue rejected again"
      });
      const pendingApproval = addPiRunGroupItem(db, {
        run_group_id: group.id,
        issue_id: 103,
        position: 3,
        issue_title_snapshot: "Implement C",
        enqueue_status: "pending_approval"
      });
      const completedItem = updatePiRunGroupItem(db, "group-1", 101, {
        final_issue_status: "done",
      });
      const completedGroup = refreshPiRunGroupCompletion(db, "group-1");
      const partial = updatePiRunGroup(db, "group-1", {
        digest_flush_sequence: 1,
        last_digest_at: "2026-06-18T01:00:00Z",
        status: "partial"
      });

      expect(group).toMatchObject({ id: "group-1", expected_issue_count: 3, status: "active" });
      expect(duplicateGroup).toMatchObject({ id: "group-1", expected_issue_count: 3 });
      expect(completedItem).toMatchObject({ issue_id: 101, report_bucket: "done", status: "reportable" });
      expect(completedGroup).toMatchObject({ id: "group-1", status: "completed" });
      expect(pendingApproval).toMatchObject({
        enqueue_status: "pending_approval",
        report_bucket: "needs_user",
        report_status: "enqueue_pending_approval",
        status: "reportable"
      });
      expect(listPiRunGroupItems(db, "group-1")).toMatchObject([
        { issue_id: 101, report_bucket: "done", report_status: "done", status: "reportable" },
        { issue_id: 102, enqueue_status: "failed", report_bucket: "skipped", report_reason: "enqueue rejected again", report_status: "enqueue_failed", status: "reportable" },
        { issue_id: 103, enqueue_status: "pending_approval", report_bucket: "needs_user", report_status: "enqueue_pending_approval", status: "reportable" }
      ]);
      expect(partial).toMatchObject({ digest_flush_sequence: 1, status: "partial" });
      expect(getPiRunGroup(db, "group-1")).toMatchObject({ last_digest_at: "2026-06-18T01:00:00Z" });
      expect(listPiRunGroups(db, { projectId: "demo", status: "partial" }).map((item) => item.id)).toEqual(["group-1"]);
    } finally {
      db.close();
    }
  });

  test("maps lifecycle statuses and enqueue outcomes through one report table", async () => {
    const db = await openFixtureDatabase();
    try {
      for (const id of [201, 202, 203, 204, 205, 206, 207, 208]) insertIssue(db, id, `Issue ${id}`);
      createPiRunGroup(db, { id: "group-lifecycle", project_id: "demo", expected_issue_count: 8 });
      for (const [index, id] of [201, 202, 203, 204, 205, 206, 207, 208].entries()) {
        addPiRunGroupItem(db, {
          run_group_id: "group-lifecycle",
          issue_id: id,
          position: index + 1,
          enqueue_status: "completed"
        });
      }

      updatePiRunGroupItem(db, "group-lifecycle", 201, { final_issue_status: "done" });
      updatePiRunGroupItem(db, "group-lifecycle", 202, { final_issue_status: "needs_user" });
      updatePiRunGroupItem(db, "group-lifecycle", 203, { final_issue_status: "failed" });
      updatePiRunGroupItem(db, "group-lifecycle", 204, { final_issue_status: "cancelled" });
      updatePiRunGroupItem(db, "group-lifecycle", 205, { enqueue_status: "pending_approval" });
      updatePiRunGroupItem(db, "group-lifecycle", 206, { final_issue_status: "blocked" });
      updatePiRunGroupItem(db, "group-lifecycle", 207, { report_status: "budget_exhausted" });
      updatePiRunGroupItem(db, "group-lifecycle", 208, { enqueue_status: "skipped" });
      const group = refreshPiRunGroupCompletion(db, "group-lifecycle");

      expect(listPiRunGroupItems(db, "group-lifecycle")).toMatchObject([
        { issue_id: 201, report_bucket: "done", report_status: "done", status: "reportable" },
        { issue_id: 202, report_bucket: "needs_user", report_status: "needs_user", status: "reportable" },
        { issue_id: 203, report_bucket: "failed", report_status: "failed", status: "reportable" },
        { issue_id: 204, report_bucket: "skipped", report_status: "cancelled", status: "reportable" },
        { issue_id: 205, report_bucket: "needs_user", report_status: "enqueue_pending_approval", status: "reportable" },
        { issue_id: 206, report_bucket: "failed", report_status: "blocked", status: "reportable" },
        { issue_id: 207, report_bucket: "needs_user", report_status: "budget_exhausted", status: "reportable" },
        { issue_id: 208, report_bucket: "skipped", report_status: "skipped", status: "reportable" }
      ]);
      expect(group.status).toBe("completed");
    } finally {
      db.close();
    }
  });

  test("creates notification intents idempotently while allowing partial and completed digest rows", async () => {
    const db = await openFixtureDatabase();
    try {
      createPiRunGroup(db, { id: "group-1", project_id: "demo", expected_issue_count: 2 });

      expect(() => createPiNotificationIntent(db, {
        id: "intent-invalid-digest",
        kind: "digest",
        project_id: "demo",
        run_group_id: "group-1",
        target_channel: "feishu",
        flush_reason: "manual"
      })).toThrow("digest intent requires");

      const partial = createPiNotificationIntent(db, {
        id: "intent-partial",
        kind: "digest",
        project_id: "demo",
        run_group_id: "group-1",
        target_channel: "feishu",
        flush_reason: "partial_deadline",
        flush_sequence: 1,
        summary: "1 done, 1 still running"
      });
      const partialDuplicate = createPiNotificationIntent(db, {
        id: "intent-partial-dupe",
        kind: "digest",
        project_id: "demo",
        run_group_id: "group-1",
        target_channel: "feishu",
        flush_reason: "partial_deadline",
        flush_sequence: 1,
        summary: "duplicate partial"
      });
      const completed = createPiNotificationIntent(db, {
        id: "intent-completed",
        kind: "digest",
        project_id: "demo",
        run_group_id: "group-1",
        target_channel: "feishu",
        flush_reason: "completed",
        flush_sequence: 2,
        summary: "all done"
      });
      const sent = updatePiNotificationIntent(db, completed.id, {
        state: "sent",
        sent_at: "2026-06-18T02:00:00Z",
        sent_outbox_id: 7
      });

      expect(partial.idempotency_key).toBe("digest:group-1:partial_deadline:1:feishu");
      expect(partialDuplicate.id).toBe(partial.id);
      const explicitDigestKey = createPiNotificationIntent(db, {
        id: "intent-explicit-digest-key",
        idempotency_key: "legacy-digest-key",
        kind: "digest",
        project_id: "demo",
        run_group_id: "group-1",
        target_channel: "feishu",
        flush_reason: "manual",
        flush_bucket: "2026-06-18T02:00:00Z"
      });

      expect(completed.idempotency_key).toBe("digest:group-1:completed:2:feishu");
      expect(explicitDigestKey.idempotency_key).toBe("digest:group-1:manual:2026-06-18T02:00:00Z:feishu");
      expect(sent).toMatchObject({ state: "sent", sent_outbox_id: 7, sent_at: "2026-06-18T02:00:00Z" });
      expect(getPiNotificationIntent(db, "intent-completed")).toMatchObject({ summary: "all done" });
      expect(listPiNotificationIntents(db, { runGroupId: "group-1" }).map((intent) => intent.id).sort()).toEqual([
        "intent-completed",
        "intent-explicit-digest-key",
        "intent-partial"
      ]);
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-guardian-runtime-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertIssue(db: RunnerDatabase, id: number, title: string): void {
  db.sqlite.run("insert or ignore into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)", [
    "demo", "Demo", `/tmp/demo-${id}`, "2026-06-18T00:00:00Z", "2026-06-18T00:00:00Z"
  ]);
  db.sqlite.run(
    "insert into issues (id, project_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
    [id, "demo", title, "todo", "2026-06-18T00:00:00Z", "2026-06-18T00:00:00Z"]
  );
}
