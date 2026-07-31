import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("In-progress reconciler API", () => {
  test("issue-state endpoint suggests pending verification without bypassing Evidence", async () => {
    const db = await openFixture();
    try {
      const issueID = insertIssue(db, "thread-success");
      insertRun(db, issueID);
      insertSession(db, issueID);
      insertEvent(db, issueID);

      const response = await createDefaultRouter({ database: db })
        .handle(new Request(`${BASE_URL}/api/projects/demo/pi/issue-state`));
      const body = await response.json() as { diagnostics: Array<Record<string, unknown>> };

      expect(response.status).toBe(200);
      expect(body.diagnostics).toContainEqual(expect.objectContaining({
        code: "in_progress_session_ended",
        issue_id: issueID,
        recommended_actions: [expect.objectContaining({ operation: "patch_status", patch: { status: "pending_verification" } })]
      }));
      expect(getIssue(db, issueID)).toMatchObject({ status: "in_progress" });
    } finally {
      db.close();
    }
  });
});

async function openFixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-in-progress-reconciler-api-"));
  tempRoots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    ["demo", "demo", join(root, "project"), "codex", 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  return db;
}

function insertIssue(db: RunnerDatabase, codexThreadID: string): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, codex_thread_id, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    ["demo", "Verified success", "in_progress", codexThreadID, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing issue id");
  return row.id;
}

function insertRun(db: RunnerDatabase, issueID: number): void {
  db.sqlite.run(
    `insert into issue_runs
      (id, issue_id, attempt, status, provider, provider_session_id, started_at, ended_at, exit_reason)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [`issue-${issueID}-attempt-1`, issueID, 1, "done", "codex", "thread-success",
      "2026-01-01T00:10:00Z", "2026-01-01T00:20:00Z", "done"]
  );
}

function insertSession(db: RunnerDatabase, issueID: number): void {
  db.sqlite.run(
    `insert into agent_sessions
      (session_key, provider, provider_session_id, project_id, issue_id, title, status, raw_ref, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["codex:thread-success", "codex", "thread-success", "demo", issueID, "Thread", "completed", "{}",
      "2026-01-01T00:00:00Z", "2026-01-01T00:21:00Z"]
  );
}

function insertEvent(db: RunnerDatabase, issueID: number): void {
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [issueID, "issue.verification_reviewed", JSON.stringify({ action: "accept", status: "done" }), "2026-01-01T00:22:00Z"]
  );
}
