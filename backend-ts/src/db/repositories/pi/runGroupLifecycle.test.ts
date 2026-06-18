import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../database.ts";
import { cancelIssue } from "../issueActions.ts";
import { updateIssue } from "../issueUpdate.ts";
import {
  addPiRunGroupItem,
  createPiRunGroup,
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
      updateIssue(db, 302, { status: "pending_verification" });
      updateIssue(db, 303, { error: "tests failed", status: "failed" });
      cancelIssue(db, 304);

      expect(listPiRunGroupItems(db, "group-sync")).toMatchObject([
        { issue_id: 301, report_bucket: "done", report_status: "done", status: "reportable" },
        { issue_id: 302, report_bucket: "verification", report_status: "pending_verification", status: "reportable" },
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
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-run-group-lifecycle-"));
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
