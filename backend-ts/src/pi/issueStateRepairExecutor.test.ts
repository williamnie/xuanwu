import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { applyIssueStateRepair } from "./issueStateManager.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Issue state repair executor", () => {
  test("executes comment, enqueue, retry, and move_status repairs with audit", async () => {
    const db = await openFixture();
    try {
      const commented = insertIssue(db, "in_progress", "Stale");
      const queued = insertIssue(db, "triage", "Queue me");
      const retried = insertIssue(db, "failed", "Retry me", "network error");
      const moved = insertIssue(db, "done", "Weak done");
      const running = insertIssue(db, "in_progress", "Other running");
      insertOpenRun(db, running);

      applyIssueStateRepair(db, {
        diagnosis_code: "stale_in_progress",
        issue_id: commented,
        operation: "comment",
        patch: { body: "please decide" },
        rationale: "stale"
      });
      applyIssueStateRepair(db, { issue_id: queued, operation: "enqueue" });
      applyIssueStateRepair(db, { issue_id: retried, operation: "retry" });
      const result = applyIssueStateRepair(db, {
        diagnosis_code: "done_missing_verification_evidence",
        issue_id: moved,
        operation: "move_status",
        patch: { status: "pending_verification" },
        rationale: "move weak done back to verification"
      });

      expect(result).toMatchObject({ status: "pending_verification" });
      expect(getIssue(db, queued)).toMatchObject({ status: "todo" });
      expect(getIssue(db, retried)).toMatchObject({ status: "todo", error: "" });
      expect(getIssue(db, moved)).toMatchObject({ status: "pending_verification" });
      expect(openRunCount(db)).toBe(1);
      expect(listIssueEvents(db, commented).map((event) => event.type)).toEqual([
        "issue.comment", "issue.state_manager_repair"
      ]);
      expect(listIssueEvents(db, moved)).toContainEqual(expect.objectContaining({
        type: "issue.state_manager_repair",
        payload: expect.stringContaining('"runner_executor_busy":true')
      }));
    } finally {
      db.close();
    }
  });
});

async function openFixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-state-repair-executor-"));
  tempRoots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    ["demo", "demo", join(root, "project"), "codex", 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  return db;
}

function insertIssue(db: RunnerDatabase, status: string, title: string, error = ""): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, error, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    ["demo", title, status, error, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing issue id");
  return row.id;
}

function insertOpenRun(db: RunnerDatabase, issueID: number): void {
  db.sqlite.run(
    `insert into issue_runs (id, issue_id, attempt, status, started_at)
     values (?, ?, ?, ?, ?)`,
    [`issue-${issueID}-attempt-1`, issueID, 1, "in_progress", "2026-01-01T00:00:00Z"]
  );
}

function openRunCount(db: RunnerDatabase): number {
  return db.sqlite.query<{ count: number }, []>(
    "select count(*) as count from issue_runs where ended_at=''"
  ).get()?.count ?? 0;
}
