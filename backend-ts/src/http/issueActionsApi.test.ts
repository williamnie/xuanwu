import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import type { ExecutorProvider, ProviderRunInput, ProviderRunResult } from "../providers/types.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

class RetryExecutionProvider implements ExecutorProvider {
  readonly id = "fake-execution-only" as const;
  readonly capabilities = ["issue_execution"] as const;
  readonly issueIDs: number[] = [];

  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    this.issueIDs.push(input.issueId);
    return { runId: `retry-run-${input.issueId}` };
  }
}

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-bun-issue-actions-api-"));
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
  test("enqueue queues idle issues and leaves actively running issues in progress", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      for (const status of ["triage", "todo", "in_progress"]) {
        const issueId = insertIssue(database, { projectId: "demo", status, title: `enqueue ${status}` });
        if (status === "in_progress") insertOpenRun(database, issueId);

        const response = await issueAction(database, issueId, "enqueue");
        const body = await response.json() as Record<string, unknown>;

        const expectedStatus = status === "in_progress" ? "in_progress" : "todo";
        expect(response.status).toBe(200);
        expect(body).toMatchObject({ id: issueId, status: expectedStatus, error: "" });
      }
      expect(listEvents(database).map((event) => event.type)).toEqual([
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

  test("retry force-starts the selected issue without reviving the project-wide failed fuse", async () => {
    const database = await openFixtureDatabase();
    const provider = new RetryExecutionProvider();
    try {
      insertProject(database, "retry-blocked", { autoRun: 1, provider: provider.id });
      insertIssue(database, { projectId: "retry-blocked", status: "failed", title: "existing blocker" });
      const retryID = insertIssue(database, { projectId: "retry-blocked", status: "failed", title: "selected retry" });

      const response = await issueAction(database, retryID, "retry", provider);
      expect(response.status).toBe(200);
      await waitFor(() => provider.issueIDs.includes(retryID));

      expect(provider.issueIDs).toEqual([retryID]);
    } finally {
      database.close();
    }
  });

  test("cancel releases the project lock and recomputes the runnable sibling", async () => {
    const database = await openFixtureDatabase();
    const provider = new RetryExecutionProvider();
    try {
      insertProject(database, "cancel-recompute", { autoRun: 1, provider: provider.id });
      const running = insertIssue(database, {
        projectId: "cancel-recompute",
        status: "in_progress",
        title: "running"
      });
      const sibling = insertIssue(database, {
        projectId: "cancel-recompute",
        status: "todo",
        title: "ready sibling"
      });
      insertOpenRun(database, running);

      const response = await issueAction(database, running, "cancel", provider);
      expect(response.status).toBe(200);
      await waitFor(() => provider.issueIDs.includes(sibling));

      expect(provider.issueIDs).toEqual([sibling]);
      expect(getIssueStatus(database, sibling)).toBe("in_progress");
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

function issueAction(
  db: RunnerDatabase,
  id: number,
  action: "cancel" | "enqueue" | "retry",
  provider?: ExecutorProvider
): Promise<Response> {
  const providers = provider ? { [provider.id]: provider } : undefined;
  return createDefaultRouter({ database: db, providers }).handle(new Request(`${BASE_URL}/api/issues/${id}/${action}`, {
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

function insertProject(
  db: RunnerDatabase,
  id: string,
  options: { autoRun?: number; provider?: string } = {}
): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, auto_run, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, options.provider ?? "codex", options.autoRun ?? 0,
      1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition was not met");
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

function getIssueStatus(db: RunnerDatabase, issueId: number): string {
  return db.sqlite.query<{ status: string }, [number]>(
    "select status from issues where id=?"
  ).get(issueId)?.status ?? "";
}

function listEvents(db: RunnerDatabase): Array<{ payload: string; type: string }> {
  return db.sqlite.query<{ payload: string; type: string }, []>(
    "select type, payload from issue_events order by id asc"
  ).all();
}

function eventWithType(db: RunnerDatabase, type: string): { payload: string; type: string } | undefined {
  return listEvents(db).find((event) => event.type === type);
}
