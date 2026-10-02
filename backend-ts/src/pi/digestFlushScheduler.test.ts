import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import {
  addPiRunGroupItem,
  createPiAction,
  createPiNotificationIntent,
  createPiRunGroup,
  getPiRunGroup,
  listPiNotificationIntents,
  updatePiRunGroup
} from "../db/repositories/pi.ts";
import { runDigestFlushSchedulerOnce } from "./digestFlushScheduler.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI digest flush scheduler", () => {
  test("repairs a legacy deleted member only from a successful matching enqueue receipt", async () => {
    const db = await openFixtureDatabase();
    try {
      insertIssue(db, 801, "Done", "done");
      insertIssue(db, 802, "Deleted", "todo");
      createPiRunGroup(db, { id: "legacy", project_id: "demo", expected_issue_count: 2 });
      [801, 802].forEach((id) => addPiRunGroupItem(db, { run_group_id: "legacy", issue_id: id }));
      createPiNotificationIntent(db, lifecycleIntent("legacy-route", 801, "legacy", "issue_done"));
      createPiAction(db, {
        id: "legacy-enqueue",
        action_type: "issue.enqueue", project_id: "demo", issue_id: 802, status: "completed",
        payload_json: JSON.stringify({ issue_id: 802, run_group_id: "legacy" }),
        result_json: JSON.stringify({ id: 802, project_id: "demo", status: "todo" })
      });
      db.sqlite.run("delete from issues where id=802");
      const first = runDigestFlushSchedulerOnce(db, { now: "2026-10-02T10:00:00Z" });
      expect(first.flushed).toBe(1);
      expect(getPiRunGroup(db, "legacy")).toMatchObject({ expected_issue_count: 2, status: "completed" });
      const digest = digestIntents(listPiNotificationIntents(db, { runGroupId: "legacy" }))[0]!;
      expect(JSON.parse(digest.payload_json)).toMatchObject({ active_count: 0, completed_count: 1, skipped_count: 1, total_count: 2 });
      expect(runDigestFlushSchedulerOnce(db, { now: "2026-10-02T12:00:00Z" }).flushed).toBe(0);
    } finally { db.close(); }
  });

  test.each(["pending", "wrong_project", "missing_receipt", "incomplete_proof"])(
    "does not shrink missing membership from %s evidence", async (evidence) => {
      const db = await openFixtureDatabase();
      try {
        insertIssue(db, 811, "Done", "done");
        const expected = evidence === "incomplete_proof" ? 3 : 2;
        createPiRunGroup(db, { id: "incomplete", project_id: "demo", expected_issue_count: expected });
        addPiRunGroupItem(db, { run_group_id: "incomplete", issue_id: 811 });
        createPiAction(db, {
          id: "unverified-enqueue",
          action_type: "issue.enqueue", project_id: "demo", issue_id: 812,
          status: evidence === "pending" ? "pending" : "completed",
          payload_json: JSON.stringify({ issue_id: 812, run_group_id: "incomplete" }),
          result_json: JSON.stringify(evidence === "missing_receipt" ? {} : {
            id: 812, project_id: evidence === "wrong_project" ? "other" : "demo"
          })
        });
        runDigestFlushSchedulerOnce(db, { now: "2026-10-02T10:00:00Z" });
        expect(getPiRunGroup(db, "incomplete")).toMatchObject({ expected_issue_count: expected });
        expect(getPiRunGroup(db, "incomplete")?.status).not.toBe("completed");
      } finally { db.close(); }
    }
  );

  test("flushes completed run groups and marks covered lifecycle intents aggregated", async () => {
    const db = await openFixtureDatabase();
    try {
      insertIssue(db, 501, "Done A", "done");
      insertIssue(db, 502, "Done B", "needs_user");
      createPiRunGroup(db, { id: "group-completed", project_id: "demo", expected_issue_count: 2 });
      addPiRunGroupItem(db, { run_group_id: "group-completed", issue_id: 501, position: 1, enqueue_status: "completed", final_issue_status: "done" });
      addPiRunGroupItem(db, { run_group_id: "group-completed", issue_id: 502, position: 2, enqueue_status: "completed", final_issue_status: "needs_user" });
      createPiNotificationIntent(db, lifecycleIntent("life-501", 501, "group-completed", "issue_done", "pending"));

      const result = runDigestFlushSchedulerOnce(db, { now: "2026-06-18T01:00:00Z" });
      const intents = listPiNotificationIntents(db, { runGroupId: "group-completed" });

      expect(result).toEqual({ flushed: 1, scanned: 1, skipped: 0 });
      expect(digestIntents(intents)).toMatchObject([
        {
          flush_reason: "completed",
          flush_sequence: 1,
          idempotency_key: "digest:group-completed:completed:1:feishu",
          state: "ready"
        }
      ]);
      expect(JSON.parse(digestIntents(intents)[0]?.payload_json ?? "{}")).toMatchObject({
        active_count: 0,
        completed_count: 1,
        needs_user_count: 1,
        total_count: 2
      });
      expect(intents.find((intent) => intent.id === "life-501")).toMatchObject({ state: "aggregated" });
      expect(groupRow(db, "group-completed")).toMatchObject({ digest_flush_sequence: 1, status: "completed" });
    } finally {
      db.close();
    }
  });

  test("flushes deadline and interval partial digests before later independent completed digest", async () => {
    const db = await openFixtureDatabase();
    try {
      insertIssue(db, 601, "Done", "done");
      insertIssue(db, 602, "Still active", "in_progress");
      createPiRunGroup(db, {
        id: "group-partial",
        project_id: "demo",
        expected_issue_count: 2,
        deadline_at: "2026-06-18T02:00:00Z",
        last_digest_at: "2026-06-18T01:00:00Z",
        max_interval_minutes: 30
      });
      addPiRunGroupItem(db, { run_group_id: "group-partial", issue_id: 601, position: 1, enqueue_status: "completed", final_issue_status: "done" });
      addPiRunGroupItem(db, { run_group_id: "group-partial", issue_id: 602, position: 2, enqueue_status: "completed" });
      createPiNotificationIntent(db, lifecycleIntent("life-601", 601, "group-partial", "issue_done"));

      const deadline = runDigestFlushSchedulerOnce(db, { now: "2026-06-18T02:00:00Z" });
      const interval = runDigestFlushSchedulerOnce(db, { now: "2026-06-18T02:31:00Z" });
      updatePiRunGroup(db, "group-partial", { deadline_at: "" });
      db.sqlite.run("update issues set status='done', updated_at=? where id=?", ["2026-06-18T02:40:00Z", 602]);

      const completed = runDigestFlushSchedulerOnce(db, { now: "2026-06-18T02:41:00Z" });
      const digests = digestIntents(listPiNotificationIntents(db, { runGroupId: "group-partial" }));

      expect(deadline).toEqual({ flushed: 1, scanned: 1, skipped: 0 });
      expect(interval).toEqual({ flushed: 1, scanned: 1, skipped: 0 });
      expect(completed).toEqual({ flushed: 1, scanned: 1, skipped: 0 });
      expect(digests.map((intent) => [intent.flush_reason, intent.flush_sequence, intent.state])).toEqual([
        ["partial_deadline", 1, "ready"],
        ["partial_interval", 2, "ready"],
        ["completed", 3, "ready"]
      ]);
      expect(groupRow(db, "group-partial")).toMatchObject({ digest_flush_sequence: 3, status: "completed" });
    } finally {
      db.close();
    }
  });

  test("inherits a non-Feishu connector and target from lifecycle intents", async () => {
    const db = await openFixtureDatabase();
    try {
      insertIssue(db, 701, "Telegram done", "done");
      createPiRunGroup(db, { id: "group-telegram", project_id: "demo", expected_issue_count: 1 });
      addPiRunGroupItem(db, {
        run_group_id: "group-telegram",
        issue_id: 701,
        position: 1,
        enqueue_status: "completed",
        final_issue_status: "done"
      });
      createPiNotificationIntent(db, {
        ...lifecycleIntent("life-701", 701, "group-telegram", "issue_done"),
        target_channel: "telegram",
        target_chat_id: "-100opaque",
        target_message_id: "message-7",
        target_thread_id: "topic-1"
      });

      expect(runDigestFlushSchedulerOnce(db, { now: "2026-06-18T03:00:00Z" })).toEqual({
        flushed: 1,
        scanned: 1,
        skipped: 0
      });
      expect(digestIntents(listPiNotificationIntents(db, { runGroupId: "group-telegram" }))).toMatchObject([{
        target_channel: "telegram",
        target_chat_id: "-100opaque",
        target_message_id: "message-7",
        target_thread_id: "topic-1"
      }]);
    } finally { db.close(); }
  });
});

function lifecycleIntent(id: string, issueID: number, runGroupID: string, kind: string, state = "aggregated") {
  return {
    decision: "aggregate",
    id,
    kind,
    issue_id: issueID,
    project_id: "demo",
    run_group_id: runGroupID,
    state,
    summary: `issue ${issueID}`,
    target_channel: "feishu"
  };
}

function digestIntents(intents: ReturnType<typeof listPiNotificationIntents>) {
  return intents.filter((intent) => intent.kind === "digest");
}

function groupRow(db: RunnerDatabase, id: string) {
  return db.sqlite.query<Record<string, unknown>, [string]>(
    "select id, status, last_digest_at, digest_flush_sequence from pi_run_groups where id=?"
  ).get(id);
}

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-pi-digest-flush-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertIssue(db: RunnerDatabase, id: number, title: string, status: string): void {
  db.sqlite.run("insert or ignore into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)", [
    "demo", "Demo", `/tmp/demo-${id}`, "2026-06-18T00:00:00Z", "2026-06-18T00:00:00Z"
  ]);
  db.sqlite.run(
    "insert into issues (id, project_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
    [id, "demo", title, status, "2026-06-18T00:00:00Z", "2026-06-18T00:00:00Z"]
  );
}
