import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../database.ts";
import { enqueueIssue, retryIssue } from "./issueActions.ts";
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
  db.sqlite.run(
    `insert into issues
      (project_id, title, status, attempt_count, codex_thread_id, codex_turn_id, created_at, updated_at)
     values (?, 'Running', 'in_progress', 1, 'thread-1', 'turn-1', ?, ?)`,
    [projectID, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
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
