import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createProjectStatusSnapshot } from "./projectSnapshot.ts";

const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-project-snapshot-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI project status snapshot", () => {
  test("summarizes issues, runs, and sessions for normal project state", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo", "/Users/secret/work/codex-issue-runner");
      const todo = insertIssue(db, { day: 1, projectID: "demo", status: "todo", title: "Todo issue" });
      const done = insertIssue(db, { day: 2, projectID: "demo", status: "done", title: "Done issue" });
      insertRun(db, { attempt: 1, issueID: todo, runID: "run-todo", status: "in_progress" });
      insertRun(db, { attempt: 1, endedAt: "2026-01-02T00:30:00Z", issueID: done, runID: "run-done", status: "done" });
      insertSession(db, { issueID: todo, projectID: "demo", sessionKey: "codex:thread-1", status: "running" });

      const snapshot = createProjectStatusSnapshot(db, "demo");

      expect(snapshot.issue_status_counts).toEqual({ done: 1, todo: 1 });
      expect(snapshot.run_status_counts).toEqual({ done: 1, in_progress: 1 });
      expect(snapshot.session_status_counts).toEqual({ running: 1 });
      expect(snapshot.latest_issues.map((issue) => issue.id)).toEqual([done, todo]);
      expect(snapshot.recent_runs[0]).toMatchObject({ issue_id: done, run_id: "run-done", status: "done" });
      expect(snapshot.recent_sessions[0]).toMatchObject({ session_key: "codex:thread-1", status: "running" });
      expect(snapshot.session_progress[0]).toMatchObject({ progress_state: "active", session_key: "codex:thread-1" });
      expect(snapshot.compact_summary).toContain("issues total=2");
      expect(JSON.stringify(snapshot)).not.toContain("/Users/secret");
    } finally {
      db.close();
    }
  });

  test("redacts failed issue and run errors in recent error summary", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo", "/Users/secret/work/codex-issue-runner");
      const failed = insertIssue(db, {
        day: 3,
        error: "provider failed CODEX_API_KEY=fixture-secret at /Users/secret/.codex/key.txt",
        projectID: "demo",
        status: "failed",
        title: "Failed issue"
      });
      insertRun(db, {
        attempt: 1,
        endedAt: "2026-01-03T00:30:00Z",
        error: "runtime failed: Bearer abc.def at /Users/secret/log.txt",
        issueID: failed,
        runID: "run-failed",
        status: "failed"
      });
      insertIssueLog(db, failed, {
        error: "tool failed AUTH_TOKEN=event-secret at /Users/secret/event.log",
        provider: "codex",
        type: "error"
      });

      const snapshot = createProjectStatusSnapshot(db, "demo");
      const json = JSON.stringify(snapshot);

      expect(snapshot.issue_status_counts).toEqual({ failed: 1 });
      expect(snapshot.findings[0]).toMatchObject({ issue_id: failed, reason: "issue_failed" });
      expect(snapshot.recent_errors.map((error) => error.source)).toEqual([
        "event",
        "run",
        "issue"
      ]);
      expect(json).toContain("[redacted]");
      expect(json).toContain("[redacted-path]");
      expect(json).not.toContain("fixture-secret");
      expect(json).not.toContain("abc.def");
      expect(json).not.toContain("event-secret");
      expect(json).not.toContain("/Users/secret");
    } finally {
      db.close();
    }
  });

  test("includes active project holds without leaking path secrets", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo", "/Users/secret/work/codex-issue-runner");
      createProjectHoldsTable(db);
      db.sqlite.run(
        `insert into project_holds
          (project_id, reason, message, hold_since, next_check_at, last_check_at, last_check_error, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "demo",
          "dirty_worktree",
          "dirty worktree at /Users/secret/work/codex-issue-runner",
          "2026-01-04T00:00:00Z",
          "",
          "2026-01-04T00:05:00Z",
          "AUTH_TOKEN=hold-secret in /Users/secret/.env",
          "2026-01-04T00:05:00Z"
        ]
      );

      const snapshot = createProjectStatusSnapshot(db, "demo");
      const json = JSON.stringify(snapshot);

      expect(snapshot.active_holds).toHaveLength(1);
      expect(snapshot.active_holds[0]).toMatchObject({ reason: "dirty_worktree" });
      expect(snapshot.findings[0]).toMatchObject({ issue_id: 0, reason: "project_hold:dirty_worktree" });
      expect(snapshot.compact_summary).toContain("holds=1");
      expect(snapshot.compact_summary).toContain("findings=1");
      expect(json).not.toContain("hold-secret");
      expect(json).not.toContain("/Users/secret");
    } finally {
      db.close();
    }
  });
});

function createProjectHoldsTable(db: RunnerDatabase): void {
  db.sqlite.run(`create table if not exists project_holds (
    project_id text primary key,
    reason text not null,
    message text not null,
    hold_since text not null,
    next_check_at text not null default '',
    last_check_at text not null default '',
    last_check_error text not null default '',
    updated_at text not null
  )`);
}

function insertIssue(db: RunnerDatabase, issue: {
  day: number; error?: string; projectID: string; status: string; title: string;
}): number {
  const timestamp = `2026-01-${String(issue.day).padStart(2, "0")}T00:00:00Z`;
  db.sqlite.run(
    `insert into issues (project_id, title, status, error, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [issue.projectID, issue.title, issue.status, issue.error ?? "", timestamp, timestamp]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing issue id");
  return row.id;
}

function insertIssueLog(db: RunnerDatabase, issueID: number, payload: Record<string, unknown>): void {
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [issueID, "issue.log", JSON.stringify(payload), "2026-01-03T00:40:00Z"]
  );
}

function insertProject(db: RunnerDatabase, id: string, cwd: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [id, id, cwd, 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertRun(db: RunnerDatabase, run: {
  attempt: number; endedAt?: string; error?: string; issueID: number; runID: string; status: string;
}): void {
  db.sqlite.run(
    `insert into issue_runs (id, issue_id, attempt, status, started_at, ended_at, error)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [run.runID, run.issueID, run.attempt, run.status, "2026-01-01T00:10:00Z", run.endedAt ?? "", run.error ?? ""]
  );
}

function insertSession(db: RunnerDatabase, session: {
  issueID: number; projectID: string; sessionKey: string; status: string;
}): void {
  const [, sessionID] = session.sessionKey.split(":");
  db.sqlite.run(
    `insert into agent_sessions
      (session_key, provider, provider_session_id, project_id, issue_id, title, status, raw_ref, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [session.sessionKey, "codex", sessionID, session.projectID, session.issueID, "Thread", session.status, "{}",
      "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"]
  );
}
