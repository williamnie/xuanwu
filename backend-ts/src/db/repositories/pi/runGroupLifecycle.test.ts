import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../database.ts";
import { cancelIssue, deleteIssues } from "../issueActions.ts";
import { updateIssue } from "../issueUpdate.ts";
import {
  addPiRunGroupItem,
  createPiRunGroup,
  getPiRunGroup,
  listPiRunGroupItems
} from "../pi.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI run group lifecycle report sync", () => {
  test("deleting members updates every affected batch without consuming unregistered slots", async () => {
    const db = await openFixtureDatabase();
    try {
      [401, 402].forEach((id) => insertIssue(db, id, `Issue ${id}`));
      for (const [id, expected] of [["complete", 2], ["unregistered", 3]] as const) {
        createPiRunGroup(db, { id, project_id: "demo", expected_issue_count: expected });
        [401, 402].forEach((issueID, position) => addPiRunGroupItem(db, {
          run_group_id: id, issue_id: issueID, position, enqueue_status: "completed"
        }));
      }
      updateIssue(db, 401, { status: "done" });
      deleteIssues(db, [402, 402]);
      expect(getPiRunGroup(db, "complete")).toMatchObject({ expected_issue_count: 2, status: "completed" });
      expect(JSON.parse(getPiRunGroup(db, "complete")!.digest_policy_json).removed_issue_ids).toEqual([402]);
      expect(getPiRunGroup(db, "unregistered")).toMatchObject({ expected_issue_count: 3, status: "active" });
      deleteIssues(db, [401]);
      expect(getPiRunGroup(db, "complete")).toMatchObject({ expected_issue_count: 2, status: "completed" });
      expect(JSON.parse(getPiRunGroup(db, "complete")!.digest_policy_json).removed_issue_ids).toEqual([401, 402]);
      createPiRunGroup(db, { id: "all-deleted", project_id: "demo", expected_issue_count: 1,
        digest_policy_json: { max_interval_minutes: 240 } });
      insertIssue(db, 403, "Deleted before completion");
      addPiRunGroupItem(db, { run_group_id: "all-deleted", issue_id: 403 });
      deleteIssues(db, [403]);
      expect(getPiRunGroup(db, "all-deleted")?.status).toBe("completed");
      expect(JSON.parse(getPiRunGroup(db, "all-deleted")!.digest_policy_json)).toEqual({
        max_interval_minutes: 240, removed_issue_ids: [403]
      });
    } finally { db.close(); }
  });

  test("rejected batch deletion preserves membership and expected counts", async () => {
    const db = await openFixtureDatabase();
    try {
      [411, 412].forEach((id) => insertIssue(db, id, `Issue ${id}`));
      createPiRunGroup(db, { id: "atomic", project_id: "demo", expected_issue_count: 2 });
      [411, 412].forEach((issueID) => addPiRunGroupItem(db, { run_group_id: "atomic", issue_id: issueID }));
      db.sqlite.run("update issues set status='in_progress' where id=412");
      expect(() => deleteIssues(db, [411, 412])).toThrow("运行中的 issue 不能删除");
      expect(getPiRunGroup(db, "atomic")?.expected_issue_count).toBe(2);
      expect(listPiRunGroupItems(db, "atomic")).toHaveLength(2);
    } finally { db.close(); }
  });

  test("syncs issue lifecycle terminal statuses into report buckets and completion", async () => {
    const db = await openFixtureDatabase();
    try {
      const ids = [301, 302, 303, 304];
      ids.forEach((id) => insertIssue(db, id, `Issue ${id}`));
      createPiRunGroup(db, { id: "group-sync", project_id: "demo", expected_issue_count: ids.length });
      ids.forEach((id, index) => addPiRunGroupItem(db, {
        enqueue_status: "completed",
        issue_id: id,
        position: index + 1,
        run_group_id: "group-sync"
      }));

      updateIssue(db, 301, { status: "done" });
      updateIssue(db, 302, { status: "needs_user" });
      updateIssue(db, 303, { error: "tests failed", status: "failed" });
      cancelIssue(db, 304);

      expect(listPiRunGroupItems(db, "group-sync")).toMatchObject([
        { issue_id: 301, report_bucket: "done", report_status: "done", status: "reportable" },
        { issue_id: 302, report_bucket: "needs_user", report_status: "needs_user", status: "reportable" },
        { issue_id: 303, report_bucket: "failed", report_reason: "tests failed", report_status: "failed", status: "reportable" },
        { issue_id: 304, report_bucket: "skipped", report_status: "cancelled", status: "reportable" }
      ]);
      expect(db.sqlite.query<{ status: string }, []>(
        "select status from pi_run_groups where id='group-sync'"
      ).get()?.status).toBe("completed");
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-pi-run-group-lifecycle-"));
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
