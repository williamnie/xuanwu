import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { scanProjectFindings } from "./projectFindings.ts";

const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-project-findings-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI failed/pending/hold scanner", () => {
  test("generates explainable findings for failed, pending verification, and project holds", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const failed = insertIssue(db, {
        day: 2,
        error: "provider failed CODEX_API_KEY=fixture-secret at /Users/secret/log.txt",
        status: "failed",
        title: "Failed task"
      });
      const pending = insertIssue(db, {
        day: 3,
        error: "bun test passed; waiting for user acceptance",
        status: "pending_verification",
        title: "Pending task"
      });
      insertIssue(db, { day: 4, status: "todo", title: "Healthy task" });
      createProjectHoldsTable(db);
      insertProjectHold(db, "demo");

      const findings = scanProjectFindings(db, "demo");

      expect(findings.map((finding) => ({ issue_id: finding.issue_id, reason: finding.reason }))).toEqual([
        { issue_id: failed, reason: "issue_failed" },
        { issue_id: pending, reason: "pending_verification" },
        { issue_id: 0, reason: "project_hold:dirty_worktree" }
      ]);
      expect(findings[0]?.message).toContain("provider failed");
      expect(findings[1]?.message).toContain("waiting for user acceptance");
      expect(findings[2]?.message).toContain("dirty worktree");
      const json = JSON.stringify(findings);
      expect(json).toContain("[redacted]");
      expect(json).toContain("[redacted-path]");
      expect(json).not.toContain("fixture-secret");
      expect(json).not.toContain("hold-secret");
      expect(json).not.toContain("/Users/secret");
    } finally {
      db.close();
    }
  });

  test("does not mutate issues, holds, events, or PI actions", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const failed = insertIssue(db, { day: 2, status: "failed", title: "Failed task" });
      createProjectHoldsTable(db);
      insertProjectHold(db, "demo");
      const before = sideEffectCounts(db, failed);

      scanProjectFindings(db, "demo");
      scanProjectFindings(db, "demo");

      expect(sideEffectCounts(db, failed)).toEqual(before);
    } finally {
      db.close();
    }
  });
});

function createProjectHoldsTable(db: RunnerDatabase): void {
  db.sqlite.run(`create table project_holds (
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
  day: number; error?: string; status: string; title: string;
}): number {
  const timestamp = `2026-01-${String(issue.day).padStart(2, "0")}T00:00:00Z`;
  db.sqlite.run(
    `insert into issues (project_id, title, status, error, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    ["demo", issue.title, issue.status, issue.error ?? "", timestamp, timestamp]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing issue id");
  return row.id;
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertProjectHold(db: RunnerDatabase, projectID: string): void {
  db.sqlite.run(
    `insert into project_holds
      (project_id, reason, message, hold_since, next_check_at, last_check_at, last_check_error, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [projectID, "dirty_worktree", "dirty worktree at /Users/secret/project",
      "2026-01-05T00:00:00Z", "", "2026-01-05T00:05:00Z",
      "AUTH_TOKEN=hold-secret in /Users/secret/.env", "2026-01-05T00:05:00Z"]
  );
}

function sideEffectCounts(db: RunnerDatabase, issueID: number) {
  const issue = db.sqlite.query(
    "select status, error, updated_at from issues where id=?"
  ).get(issueID);
  return {
    actions: countRows(db, "select count(*) as count from pi_actions"),
    events: countRows(db, "select count(*) as count from issue_events"),
    holds: countRows(db, "select count(*) as count from project_holds"),
    issue
  };
}

function countRows(db: RunnerDatabase, sql: string): number {
  const row = db.sqlite.query<{ count: number }, []>(sql).get();
  return row?.count ?? 0;
}
