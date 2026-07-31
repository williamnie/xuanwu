import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../database.ts";
import { deleteIssues, enqueueIssue, retryIssue } from "./issueActions.ts";
import { claimNextIssue } from "./issueQueue.ts";
import { getIssue, listIssueRuns } from "./issues.ts";

const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-issue-actions-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("issue action repository", () => {
  test("enqueue is idempotent for an already running issue with an open run", async () => {
    await expectRunningActionToBeIdempotent(enqueueIssue);
  });

  test("retry is idempotent for an already running issue with an open run", async () => {
    await expectRunningActionToBeIdempotent(retryIssue);
  });

  test("deduplicates a terminal retry and materializes one new Run on claim", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const issueID = insertRunningIssue(db, "demo");
      insertOpenRun(db, issueID);
      db.sqlite.run(`update issue_runs set status='failed', ended_at=?, exit_reason='provider_failed', error='failed'
        where issue_id=?`, ["2026-01-01T00:01:00Z", issueID]);
      db.sqlite.run("update issues set status='failed', error='failed' where id=?", [issueID]);

      expect(retryIssue(db, issueID)).toMatchObject({ status: "todo" });
      expect(retryIssue(db, issueID)).toMatchObject({ status: "todo" });
      expect(lifecycleEvents(db, issueID, "run.lifecycle.run_requested.v1")).toHaveLength(1);

      expect(claimNextIssue(db, "demo")).toMatchObject({ id: issueID, status: "in_progress" });
      expect(listIssueRuns(db, issueID).map((run) => ({ attempt: run.attempt, status: run.status }))).toEqual([
        { attempt: 1, status: "failed" },
        { attempt: 2, status: "in_progress" }
      ]);
      expect(lifecycleEvents(db, issueID, "run.lifecycle.run_materialized.v1")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("batch delete is atomic when any issue still has an open Run", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const deletableID = insertIssue(db, "demo", "triage");
      const runningID = insertRunningIssue(db, "demo");
      insertOpenRun(db, runningID);

      expect(() => deleteIssues(db, [deletableID, runningID]))
        .toThrow("运行中的 issue 不能删除，请先取消执行");
      expect(getIssue(db, deletableID)).toMatchObject({ id: deletableID, status: "triage" });
      expect(getIssue(db, runningID)).toMatchObject({ id: runningID, status: "in_progress" });
    } finally {
      db.close();
    }
  });
});

async function expectRunningActionToBeIdempotent(
  action: typeof enqueueIssue
): Promise<void> {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const issueID = insertRunningIssue(db, "demo");
      insertOpenRun(db, issueID);

      const issue = action(db, issueID);

      expect(issue).toMatchObject({ id: issueID, status: "in_progress", attempt_count: 1 });
      expect(getIssue(db, issueID)).toMatchObject({ status: "in_progress", attempt_count: 1 });
      expect(listIssueRuns(db, issueID)).toMatchObject([{
        id: `issue-${issueID}-attempt-1`,
        status: "in_progress",
        provider_session_id: "thread-1",
        provider_turn_id: "turn-1",
        ended_at: ""
      }]);
      expect(statusEvents(db, issueID)).toEqual([]);
    } finally {
      db.close();
    }
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
     values (?, ?, ?, 'codex', 1, ?, ?)`,
    [id, id, `/tmp/${id}`, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertRunningIssue(db: RunnerDatabase, projectID: string): number {
  return insertIssue(db, projectID, "in_progress", {
    codexThreadID: "thread-1",
    codexTurnID: "turn-1",
    attemptCount: 1
  });
}

function insertIssue(
  db: RunnerDatabase,
  projectID: string,
  status: string,
  options: { attemptCount?: number; codexThreadID?: string; codexTurnID?: string } = {}
): number {
  db.sqlite.run(
    `insert into issues
      (project_id, title, status, attempt_count, codex_thread_id, codex_turn_id, created_at, updated_at)
     values (?, 'Issue', ?, ?, ?, ?, ?, ?)`,
    [
      projectID,
      status,
      options.attemptCount ?? 0,
      options.codexThreadID ?? "",
      options.codexTurnID ?? "",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z"
    ]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing inserted issue id");
  return row.id;
}

function insertOpenRun(db: RunnerDatabase, issueID: number): void {
  db.sqlite.run(
    `insert into issue_runs
      (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id,
       codex_thread_id, codex_turn_id, started_at, ended_at)
     values (?, ?, 1, 'in_progress', 'codex', 'thread-1', 'turn-1', 'thread-1', 'turn-1', ?, '')`,
    [`issue-${issueID}-attempt-1`, issueID, "2026-01-01T00:00:00Z"]
  );
}

function statusEvents(db: RunnerDatabase, issueID: number): string[] {
  return db.sqlite.query<{ payload: string }, [number]>(
    "select payload from issue_events where issue_id=? and type='issue.status_changed' order by id"
  ).all(issueID).map((row) => row.payload);
}

function lifecycleEvents(db: RunnerDatabase, issueID: number, type: string): string[] {
  return db.sqlite.query<{ payload: string }, [number, string]>(
    "select payload from issue_events where issue_id=? and type=? order by id"
  ).all(issueID, type).map((row) => row.payload);
}
