import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { diagnoseIssueState } from "./issueStateManager.ts";

const tempRoots: string[] = [];
const NOW = new Date("2026-01-01T01:00:00Z");

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("In-progress reconciler", () => {
  test("suggests pending verification for an ended successful run without bypassing the Evidence gate", async () => {
    const db = await openFixture();
    try {
      const issueID = insertIssue(db, "Verified success", "thread-success");
      insertRun(db, issueID, { endedAt: "2026-01-01T00:20:00Z", sessionID: "thread-success", status: "done" });
      insertSession(db, issueID, { sessionID: "thread-success", status: "completed" });
      insertEvent(db, issueID, "issue.verification_reviewed", { action: "accept", status: "done" });

      const diagnostic = onlyDiagnostic(db, issueID);

      expect(diagnostic).toMatchObject({
        code: "in_progress_session_ended",
        recommended_actions: [expect.objectContaining({ operation: "patch_status", patch: { status: "pending_verification" } })]
      });
      expect(getIssue(db, issueID)).toMatchObject({ status: "in_progress" });
    } finally {
      db.close();
    }
  });

  test("suggests failed for ended failed run", async () => {
    const db = await openFixture();
    try {
      const issueID = insertIssue(db, "Failed run", "thread-failed");
      insertRun(db, issueID, {
        endedAt: "2026-01-01T00:20:00Z",
        error: "unit tests failed",
        sessionID: "thread-failed",
        status: "failed"
      });
      insertSession(db, issueID, { sessionID: "thread-failed", status: "failed" });

      expect(onlyDiagnostic(db, issueID)).toMatchObject({
        code: "in_progress_session_ended",
        recommended_actions: [expect.objectContaining({
          operation: "patch_status",
          patch: { error: "unit tests failed", status: "failed" }
        })]
      });
    } finally {
      db.close();
    }
  });

  test("does not report active running issue", async () => {
    const db = await openFixture();
    try {
      const issueID = insertIssue(db, "Still running", "thread-running");
      insertRun(db, issueID, { endedAt: "", sessionID: "thread-running", status: "in_progress" });
      insertSession(db, issueID, { sessionID: "thread-running", status: "running" });

      const diagnostics = diagnoseIssueState(db, { now: NOW, projectID: "demo" }).diagnostics;

      expect(diagnostics.map((item) => item.issue_id)).not.toContain(issueID);
    } finally {
      db.close();
    }
  });
});

async function openFixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-in-progress-reconciler-"));
  tempRoots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    ["demo", "demo", join(root, "project"), "codex", 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  return db;
}

function insertIssue(db: RunnerDatabase, title: string, codexThreadID: string): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, codex_thread_id, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    ["demo", title, "in_progress", codexThreadID, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing issue id");
  return row.id;
}

function insertRun(db: RunnerDatabase, issueID: number, run: { endedAt: string; error?: string; sessionID: string; status: string }): void {
  db.sqlite.run(
    `insert into issue_runs
      (id, issue_id, attempt, status, provider, provider_session_id, started_at, ended_at, exit_reason, error)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [`issue-${issueID}-attempt-1`, issueID, 1, run.status, "codex", run.sessionID,
      "2026-01-01T00:10:00Z", run.endedAt, run.status, run.error ?? ""]
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

function insertEvent(db: RunnerDatabase, issueID: number, type: string, payload: unknown): void {
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [issueID, type, JSON.stringify(payload), "2026-01-01T00:22:00Z"]
  );
}

function onlyDiagnostic(db: RunnerDatabase, issueID: number) {
  const diagnostics = diagnoseIssueState(db, { now: NOW, projectID: "demo" }).diagnostics;
  return diagnostics.find((item) => item.issue_id === issueID);
}
