import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3018";
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-issue-actions-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun issue action API", () => {
  test("enqueue moves triage, todo, and in_progress issues to todo", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      for (const status of ["triage", "todo", "in_progress"]) {
        const issueId = insertIssue(database, { projectId: "demo", status, title: `enqueue ${status}` });
        if (status === "in_progress") insertOpenRun(database, issueId);

        const response = await issueAction(database, issueId, "enqueue");
        const body = await response.json() as Record<string, unknown>;

        expect(response.status).toBe(200);
        expect(body).toMatchObject({ id: issueId, status: "todo", error: "" });
      }
      expect(listEvents(database).map((event) => event.type)).toEqual([
        "issue.status_changed",
        "issue.status_changed",
        "issue.status_changed"
      ]);
    } finally {
      database.close();
    }
  });

  test("retry moves terminal issues to todo and clears retry state", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      for (const status of ["done", "failed", "cancelled", "pending_verification"]) {
        const issueId = insertIssue(database, {
          projectId: "demo",
          status,
          title: `retry ${status}`,
          error: "previous failure",
          codexThreadId: `thread-${status}`,
          codexTurnId: `turn-${status}`,
          autoRetryNextAt: "2026-01-02T00:00:00Z",
          autoRetryReason: "network timeout"
        });

        const response = await issueAction(database, issueId, "retry");
        const body = await response.json() as Record<string, unknown>;

        expect(response.status).toBe(200);
        expect(body).toMatchObject({
          id: issueId,
          status: "todo",
          error: "",
          codex_thread_id: `thread-${status}`,
          codex_turn_id: "",
          auto_retry_next_at: "",
          auto_retry_reason: ""
        });
      }
    } finally {
      database.close();
    }
  });

  test("cancel marks issues cancelled, closes open runs, and records issue_cancel", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const issueId = insertIssue(database, {
        projectId: "demo",
        status: "in_progress",
        title: "cancel running",
        codexThreadId: "thread-cancel",
        codexTurnId: "turn-cancel"
      });
      insertOpenRun(database, issueId);

      const response = await issueAction(database, issueId, "cancel");
      const body = await response.json() as Record<string, unknown>;
      const run = latestRun(database, issueId);

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ id: issueId, status: "cancelled" });
      expect(run).toMatchObject({ status: "cancelled", exit_reason: "issue_cancel" });
      expect(run?.ended_at).not.toBe("");
      expect(eventWithType(database, "issue.status_changed")?.payload).toBe(JSON.stringify({
        status: "cancelled",
        reason: "issue_cancel"
      }));
    } finally {
      database.close();
    }
  });

  test("cancel also moves queued and terminal issues to cancelled", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      for (const status of ["triage", "todo", "done", "failed", "cancelled", "pending_verification"]) {
        const issueId = insertIssue(database, {
          projectId: "demo",
          status,
          title: `cancel ${status}`,
          error: "existing error",
          autoRetryNextAt: "2026-01-02T00:00:00Z",
          autoRetryReason: "network timeout"
        });

        const response = await issueAction(database, issueId, "cancel");
        const body = await response.json() as Record<string, unknown>;

        expect(response.status).toBe(200);
        expect(body).toMatchObject({
          id: issueId,
          status: "cancelled",
          error: "",
          auto_retry_next_at: "",
          auto_retry_reason: ""
        });
      }
    } finally {
      database.close();
    }
  });
});

function issueAction(db: RunnerDatabase, id: number, action: "cancel" | "enqueue" | "retry"): Promise<Response> {
  return createDefaultRouter({ database: db }).handle(new Request(`${BASE_URL}/api/issues/${id}/${action}`, {
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json" }
  }));
}

type IssueFixture = {
  autoRetryNextAt?: string;
  autoRetryReason?: string;
  codexThreadId?: string;
  codexTurnId?: string;
  error?: string;
  projectId: string;
  status: string;
  title: string;
};

function insertIssue(db: RunnerDatabase, issue: IssueFixture): number {
  db.sqlite.run(
    `insert into issues
      (project_id, title, status, error, codex_thread_id, codex_turn_id,
       auto_retry_next_at, auto_retry_reason, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      issue.projectId,
      issue.title,
      issue.status,
      issue.error ?? "",
      issue.codexThreadId ?? "",
      issue.codexTurnId ?? "",
      issue.autoRetryNextAt ?? "",
      issue.autoRetryReason ?? "",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z"
    ]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing inserted issue id");
  return row.id;
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertOpenRun(db: RunnerDatabase, issueId: number): void {
  db.sqlite.run(
    `insert into issue_runs (id, issue_id, attempt, status, started_at)
     values (?, ?, ?, ?, ?)`,
    [`issue-${issueId}-attempt-1`, issueId, 1, "in_progress", "2026-01-01T00:00:00Z"]
  );
}

function latestRun(db: RunnerDatabase, issueId: number): Record<string, unknown> | null {
  return db.sqlite.query<Record<string, unknown>, [number]>(
    "select status, ended_at, exit_reason from issue_runs where issue_id = ? order by attempt desc limit 1"
  ).get(issueId) ?? null;
}

function listEvents(db: RunnerDatabase): Array<{ payload: string; type: string }> {
  return db.sqlite.query<{ payload: string; type: string }, []>(
    "select type, payload from issue_events order by id asc"
  ).all();
}

function eventWithType(db: RunnerDatabase, type: string): { payload: string; type: string } | undefined {
  return listEvents(db).find((event) => event.type === type);
}
