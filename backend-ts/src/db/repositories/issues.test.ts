import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../database.ts";
import { getIssue, listIssues } from "./issues.ts";

const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-issues-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("issue read repository", () => {
  test("returns an empty issue list", async () => {
    const db = await openFixtureDatabase();
    try {
      expect(listIssues(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("gets one issue with frontend-compatible fields", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const id = insertIssue(db, {
        project_id: "demo",
        title: "Read repositories",
        status: "todo",
        priority: 3,
        source_session_id: "thread-1",
        created_at: "2026-01-01T00:00:00Z"
      });
      insertIssueComment(db, id);
      insertIssueRun(db, { issueId: id, attempt: 1, status: "failed" });
      insertIssueRun(db, { issueId: id, attempt: 2, status: "in_progress" });

      expect(getIssue(db, id)).toEqual({
        id,
        project_id: "demo",
        title: "Read repositories",
        description: "",
        status: "todo",
        priority: 3,
        required_skill_intents: "[]",
        recommended_skill_intents: "[]",
        required_mcp_capabilities: "[]",
        recommended_mcp_capabilities: "[]",
        agent_profile_id: "",
        service_tier: "",
        source_session_id: "thread-1",
        source_turn_id: "",
        source_excerpt: "",
        codex_thread_id: "",
        codex_turn_id: "",
        attempt_count: 0,
        comment_count: 1,
        workflow_snapshot_json: "",
        auto_retry_next_at: "",
        auto_retry_reason: "",
        error: "",
        issue_log_mode: "normal",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z"
      });
      expect(getIssue(db, 9999)).toBeNull();
    } finally {
      db.close();
    }
  });

  test("filters issues by project, status, and source session", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      insertProject(db, "other");
      const todo = insertIssue(db, {
        project_id: "demo",
        title: "todo",
        status: "todo",
        priority: 1,
        source_session_id: "thread-a",
        created_at: "2026-01-02T00:00:00Z"
      });
      const triage = insertIssue(db, {
        project_id: "demo",
        title: "triage",
        status: "triage",
        priority: 0,
        source_session_id: "thread-a",
        created_at: "2026-01-01T00:00:00Z"
      });
      insertIssue(db, {
        project_id: "other",
        title: "other",
        status: "todo",
        priority: 5,
        source_session_id: "thread-b",
        created_at: "2026-01-03T00:00:00Z"
      });

      expect(listIssues(db, { projectId: "demo" }).map((issue) => issue.id)).toEqual([todo, triage]);
      expect(listIssues(db, { status: "triage" }).map((issue) => issue.id)).toEqual([triage]);
      expect(listIssues(db, { sourceSessionId: "codex:thread-a" }).map((issue) => issue.id)).toEqual([todo, triage]);
      expect(listIssues(db, { projectId: "demo", status: "todo", sourceSessionId: "thread-a" }).map((issue) => issue.id)).toEqual([todo]);
    } finally {
      db.close();
    }
  });
});

type IssueFixture = {
  created_at: string;
  priority: number;
  project_id: string;
  source_session_id: string;
  status: string;
  title: string;
};

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, issue: IssueFixture): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, priority, source_session_id, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [
      issue.project_id,
      issue.title,
      issue.status,
      issue.priority,
      issue.source_session_id,
      issue.created_at,
      issue.created_at
    ]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing inserted issue id");
  return row.id;
}

function insertIssueComment(db: RunnerDatabase, issueId: number): void {
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, 'issue.comment', '{}', ?)`,
    [issueId, "2026-01-01T00:00:00Z"]
  );
}

type IssueRunFixture = {
  attempt: number;
  issueId: number;
  status: string;
};

function insertIssueRun(db: RunnerDatabase, run: IssueRunFixture): void {
  db.sqlite.run(
    `insert into issue_runs (id, issue_id, attempt, status, started_at) values (?, ?, ?, ?, ?)`,
    [
      `issue-${run.issueId}-attempt-${run.attempt}`,
      run.issueId,
      run.attempt,
      run.status,
      `2026-01-0${run.attempt}T00:00:00Z`
    ]
  );
}
