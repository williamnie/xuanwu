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

  test("detects stale in-progress issues from issue, run, and session activity thresholds", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const stale = insertIssue(db, {
        codexThreadID: "thread-stale",
        day: 1,
        status: "in_progress",
        title: "Stale task"
      });
      insertRun(db, stale, { sessionID: "thread-stale", startedAt: "2026-01-01T00:05:00Z" });
      insertSession(db, stale, { sessionID: "thread-stale", status: "completed", updatedAt: "2026-01-01T00:10:00Z" });

      const findings = scanProjectFindings(db, "demo", {
        now: new Date("2026-01-01T01:30:00Z"),
        staleAfterMs: 60 * 60 * 1000
      });

      expect(findings).toContainEqual(expect.objectContaining({
        action_candidate: expect.objectContaining({ action_type: "session.steer_proposal" }),
        category: "needs_user",
        issue_id: stale,
        reason: "stale_issue",
        status: "in_progress"
      }));
      expect(findings.find((finding) => finding.issue_id === stale)?.message).toContain("inactive for 80m");
    } finally {
      db.close();
    }
  });

  test("does not mark active or recently updated Codex sessions as stale", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const running = insertIssue(db, {
        codexThreadID: "thread-active",
        day: 1,
        status: "in_progress",
        title: "Active task"
      });
      const recent = insertIssue(db, {
        codexThreadID: "thread-recent",
        day: 1,
        status: "in_progress",
        title: "Recently updated task"
      });
      insertRun(db, running, { sessionID: "thread-active", startedAt: "2026-01-01T00:05:00Z" });
      insertSession(db, running, { sessionID: "thread-active", status: "running", updatedAt: "2026-01-01T00:10:00Z" });
      insertRun(db, recent, { sessionID: "thread-recent", startedAt: "2026-01-01T00:05:00Z" });
      insertSession(db, recent, { sessionID: "thread-recent", status: "completed", updatedAt: "2026-01-01T01:20:00Z" });

      const findings = scanProjectFindings(db, "demo", {
        now: new Date("2026-01-01T01:30:00Z"),
        staleAfterMs: 60 * 60 * 1000
      });

      expect(findings.some((finding) => finding.issue_id === running)).toBe(false);
      expect(findings.some((finding) => finding.issue_id === recent)).toBe(false);
    } finally {
      db.close();
    }
  });

  test("classifies transient, needs-user, blocked, and verification-needed findings", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const transient = insertIssue(db, {
        autoRetryNextAt: "2026-01-01T02:00:00Z",
        autoRetryReason: "Transport error: network error",
        day: 1,
        status: "todo",
        title: "Retry later"
      });
      const transientFailed = insertIssue(db, {
        day: 1,
        error: "stream disconnected before completion",
        status: "failed",
        title: "Retryable failure"
      });
      const needsUser = insertIssue(db, {
        day: 2,
        error: "approval denied; user input required",
        status: "failed",
        title: "Needs user"
      });
      const blocked = insertIssue(db, {
        day: 3,
        error: "unit tests failed",
        status: "failed",
        title: "Blocked task"
      });
      const pending = insertIssue(db, {
        day: 4,
        error: "bun test passed; waiting for user acceptance",
        status: "pending_verification",
        title: "Pending task"
      });

      const findings = scanProjectFindings(db, "demo", { now: new Date("2026-01-01T01:30:00Z") });
      const categories = new Map(findings.map((finding) => [finding.issue_id, finding.category]));

      expect(categories.get(transient)).toBe("transient");
      expect(categories.get(transientFailed)).toBe("transient");
      expect(categories.get(needsUser)).toBe("needs_user");
      expect(categories.get(blocked)).toBe("blocked");
      expect(categories.get(pending)).toBe("verification_needed");
      expect(findings.find((finding) => finding.issue_id === needsUser)?.notification).toMatchObject({
        type: "pi.needs_user"
      });
      expect(findings.find((finding) => finding.issue_id === needsUser)?.message).toContain("approval denied");
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
  autoRetryNextAt?: string; autoRetryReason?: string; codexThreadID?: string;
  day: number; error?: string; status: string; title: string;
}): number {
  const timestamp = `2026-01-${String(issue.day).padStart(2, "0")}T00:00:00Z`;
  db.sqlite.run(
    `insert into issues
      (project_id, title, status, error, codex_thread_id, auto_retry_next_at,
       auto_retry_reason, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["demo", issue.title, issue.status, issue.error ?? "", issue.codexThreadID ?? "",
      issue.autoRetryNextAt ?? "", issue.autoRetryReason ?? "", timestamp, timestamp]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing issue id");
  return row.id;
}

function insertRun(db: RunnerDatabase, issueID: number, input: { sessionID: string; startedAt: string }): void {
  db.sqlite.run(
    `insert into issue_runs
      (id, issue_id, attempt, status, provider_session_id, started_at)
     values (?, ?, ?, ?, ?, ?)`,
    [`issue-${issueID}-attempt-1`, issueID, 1, "in_progress", input.sessionID, input.startedAt]
  );
}

function insertSession(db: RunnerDatabase, issueID: number, input: {
  sessionID: string; status: string; updatedAt: string;
}): void {
  db.sqlite.run(
    `insert into agent_sessions
      (session_key, provider, provider_session_id, project_id, issue_id, title, status,
       raw_ref, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [`codex:${input.sessionID}`, "codex", input.sessionID, "demo", issueID, "Thread",
      input.status, "{}", "2026-01-01T00:00:00Z", input.updatedAt]
  );
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
