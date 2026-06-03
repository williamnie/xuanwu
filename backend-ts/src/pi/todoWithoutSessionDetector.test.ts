import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { diagnoseIssueState } from "./issueStateManager.ts";

const tempRoots: string[] = [];
const NOW = new Date("2026-01-01T01:00:00Z");

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Todo without session detector", () => {
  test("generates kick/enqueue candidate when todo only has ended historical runtime", async () => {
    const db = await openFixture();
    try {
      const todo = insertIssue(db, "todo", "Requeued without active session", "thread-old");
      insertRun(db, todo, { endedAt: "2026-01-01T00:20:00Z", sessionID: "thread-old", status: "done" });
      insertSession(db, todo, { sessionID: "thread-old", status: "completed" });

      const result = diagnoseIssueState(db, { now: NOW, projectID: "demo" });

      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        code: "todo_without_session",
        issue_id: todo,
        recommended_actions: [expect.objectContaining({
          operation: "enqueue",
          suggested_operation: "kick_project_loop"
        })]
      }));
      expect(JSON.stringify(result.diagnostics)).toContain("project auto_run=1");
    } finally {
      db.close();
    }
  });

  test("skips active runtime and non-todo issues", async () => {
    const db = await openFixture();
    try {
      const openRun = insertIssue(db, "todo", "Todo with open run");
      insertRun(db, openRun, { endedAt: "", sessionID: "thread-open", status: "in_progress" });
      const runningSession = insertIssue(db, "todo", "Todo with running session");
      insertSession(db, runningSession, { sessionID: "thread-running", status: "running" });
      const triage = insertIssue(db, "triage", "Triage without session");

      const ids = diagnoseIssueState(db, { now: NOW, projectID: "demo" }).diagnostics
        .filter((item) => item.code === "todo_without_session")
        .map((item) => item.issue_id);

      expect(ids).not.toContain(openRun);
      expect(ids).not.toContain(runningSession);
      expect(ids).not.toContain(triage);
    } finally {
      db.close();
    }
  });
});

async function openFixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-todo-detector-"));
  tempRoots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, auto_run, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["demo", "demo", join(root, "project"), "codex", 1, 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  return db;
}

function insertIssue(db: RunnerDatabase, status: string, title: string, codexThreadID = ""): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, codex_thread_id, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    ["demo", title, status, codexThreadID, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing issue id");
  return row.id;
}

function insertRun(db: RunnerDatabase, issueID: number, run: { endedAt: string; sessionID: string; status: string }): void {
  db.sqlite.run(
    `insert into issue_runs (id, issue_id, attempt, status, provider, provider_session_id, started_at, ended_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [`issue-${issueID}-attempt-1`, issueID, 1, run.status, "codex", run.sessionID, "2026-01-01T00:10:00Z", run.endedAt]
  );
}

function insertSession(db: RunnerDatabase, issueID: number, input: { sessionID: string; status: string }): void {
  db.sqlite.run(
    `insert into agent_sessions
      (session_key, provider, provider_session_id, project_id, issue_id, title, status, raw_ref, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [`codex:${input.sessionID}`, "codex", input.sessionID, "demo", issueID, "Thread", input.status, "{}",
      "2026-01-01T00:00:00Z", "2026-01-01T00:21:00Z"]
  );
}
