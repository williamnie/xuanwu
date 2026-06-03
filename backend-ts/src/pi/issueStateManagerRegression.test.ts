import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { diagnoseIssueState } from "./issueStateManager.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Issue State Manager regressions", () => {
  test("handles invalid retry timestamps without crashing", async () => {
    const db = await openFixture();
    try {
      const issueID = insertIssue(db, {
        attemptCount: 1,
        autoRetryNextAt: "not-a-date",
        error: "network error",
        status: "failed",
        title: "Invalid dates",
        updatedAt: "also-not-a-date"
      });

      const result = diagnoseIssueState(db, { now: new Date("2026-01-01T01:00:00Z"), projectID: "demo" });

      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        code: "failed_retry_ready",
        issue_id: issueID
      }));
    } finally {
      db.close();
    }
  });

  test("compares latest activity by parsed timestamp rather than string order", async () => {
    const db = await openFixture();
    try {
      const issueID = insertIssue(db, {
        status: "in_progress",
        title: "Mixed timestamp precision",
        updatedAt: "2026-01-01T00:00:00Z"
      });
      insertRun(db, issueID, "2026-01-01T00:00:00.500Z");

      const result = diagnoseIssueState(db, {
        now: new Date("2026-01-01T02:00:00.250Z"),
        projectID: "demo",
        staleAfterMs: 2 * 60 * 60 * 1000
      });

      expect(result.diagnostics.map((item) => item.issue_id)).not.toContain(issueID);
    } finally {
      db.close();
    }
  });

  test("does not treat generic build or lint words as verification evidence", async () => {
    const db = await openFixture();
    try {
      const issueID = insertIssue(db, {
        status: "done",
        title: "Done with weak comment",
        updatedAt: "2026-01-01T00:00:00Z"
      });
      insertEvent(db, issueID, "issue.comment", { note: "build artifact uploaded" });

      const result = diagnoseIssueState(db, { now: new Date("2026-01-01T01:00:00Z"), projectID: "demo" });

      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        code: "done_missing_verification_evidence",
        issue_id: issueID
      }));
    } finally {
      db.close();
    }
  });
});

async function openFixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-issue-state-regression-"));
  tempRoots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, provider_config_json, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["demo", "demo", join(root, "project"), "codex", '{}', 1,
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  return db;
}

function insertIssue(db: RunnerDatabase, issue: {
  attemptCount?: number; autoRetryNextAt?: string; error?: string; status: string; title: string; updatedAt: string;
}): number {
  db.sqlite.run(
    `insert into issues
      (project_id, title, status, error, attempt_count, auto_retry_next_at, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["demo", issue.title, issue.status, issue.error ?? "", issue.attemptCount ?? 0,
      issue.autoRetryNextAt ?? "", issue.updatedAt, issue.updatedAt]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing issue id");
  return row.id;
}

function insertRun(db: RunnerDatabase, issueID: number, startedAt: string): void {
  db.sqlite.run(
    `insert into issue_runs
      (id, issue_id, attempt, status, provider, provider_session_id, started_at, ended_at, exit_reason)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [`issue-${issueID}-attempt-1`, issueID, 1, "in_progress", "codex", "thread-mixed", startedAt, "", ""]
  );
}

function insertEvent(db: RunnerDatabase, issueID: number, type: string, payload: unknown): void {
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [issueID, type, JSON.stringify(payload), "2026-01-01T00:00:00Z"]
  );
}
