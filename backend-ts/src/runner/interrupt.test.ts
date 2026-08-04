import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { runProjectLoopOnce } from "./projectLoop.ts";
import { cancelIssueWithInterrupt, retryIssueWithInterrupt } from "./interrupt.ts";
import type { ExecutorProvider, InterruptInput, ProviderRunInput } from "../providers/types.ts";

const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-bun-interrupt-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun issue interrupt runtime", () => {
  test("cancel interrupts the linked Codex turn once and remains idempotent", async () => {
    const db = await openFixtureDatabase();
    const provider = new InterruptCaptureProvider();
    try {
      insertProject(db, "demo");
      const issueId = insertIssue(db, "demo", "in_progress", "thread-cancel", "turn-cancel");
      insertOpenRun(db, issueId);

      const issue = await cancelIssueWithInterrupt(db, issueId, { providers: { codex: provider } });
      const repeat = await cancelIssueWithInterrupt(db, issueId, { providers: { codex: provider } });
      const eventTypes = listEvents(db).map((event) => event.type);

      expect(issue.status).toBe("cancelled");
      expect(repeat.status).toBe("cancelled");
      expect(provider.interrupts).toEqual([{
        session: { provider: "codex", sessionId: "thread-cancel", turnId: "turn-cancel" },
        reason: "issue_cancel"
      }]);
      expect(eventTypes).toContain("issue.interrupt_requested");
      expect(eventTypes).toContain("issue.interrupted");
      expect(latestRun(db, issueId)).toMatchObject({ status: "cancelled", exit_reason: "issue_cancel" });
      expect(latestAttempt(db, issueId)).toMatchObject({ status: "interrupted" });
    } finally {
      db.close();
    }
  });

  test("cancel closes the run and records diagnostics when Codex interrupt times out", async () => {
    const db = await openFixtureDatabase();
    const provider = new InterruptCaptureProvider({ hang: true });
    try {
      insertProject(db, "demo");
      const issueId = insertIssue(db, "demo", "in_progress", "thread-slow", "turn-slow");
      insertOpenRun(db, issueId);

      const startedAt = Date.now();
      const issue = await cancelIssueWithInterrupt(db, issueId, {
        interruptTimeoutMs: 5,
        providers: { codex: provider }
      });

      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(issue.status).toBe("cancelled");
      expect(provider.interrupts).toHaveLength(1);
      expect(latestRun(db, issueId)).toMatchObject({ status: "cancelled", exit_reason: "issue_cancel" });
      expect(eventWithType(db, "issue.interrupt_failed")?.payload).toContain("timed out");
    } finally {
      db.close();
    }
  });

  test("retry interrupts the old turn before closing and requeueing its run", async () => {
    const db = await openFixtureDatabase();
    const provider = new InterruptCaptureProvider();
    try {
      insertProject(db, "demo");
      const issueId = insertIssue(db, "demo", "in_progress", "thread-retry", "turn-retry");
      insertOpenRun(db, issueId);

      const issue = await retryIssueWithInterrupt(db, issueId, {}, { providers: { codex: provider } });

      expect(issue.status).toBe("todo");
      expect(provider.interrupts).toEqual([{
        session: { provider: "codex", sessionId: "thread-retry", turnId: "turn-retry" },
        reason: "issue_retry"
      }]);
      expect(latestRun(db, issueId)).toMatchObject({
        status: "cancelled",
        exit_reason: `superseded_by:xw:run:issue_runs:issue-${issueId}-attempt-2`
      });
      expect(eventWithType(db, "issue.interrupted")?.payload).toContain("issue_retry");
    } finally {
      db.close();
    }
  });

  test("retry supersedes an open run without interrupting a terminal provider session", async () => {
    const db = await openFixtureDatabase();
    const provider = new InterruptCaptureProvider({ reject: new Error("terminal session must not be interrupted") });
    try {
      insertProject(db, "demo");
      const issueId = insertIssue(db, "demo", "in_progress", "thread-completed", "turn-completed");
      insertOpenRun(db, issueId);
      insertAgentSession(db, issueId, "demo", "thread-completed", "completed");

      const issue = await retryIssueWithInterrupt(db, issueId, {}, { providers: { codex: provider } });

      expect(issue.status).toBe("todo");
      expect(provider.interrupts).toEqual([]);
      expect(latestRun(db, issueId)).toMatchObject({
        status: "cancelled",
        exit_reason: `superseded_by:xw:run:issue_runs:issue-${issueId}-attempt-2`
      });
      expect(eventWithType(db, "issue.interrupt_requested")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("retry leaves the running issue intact when the old turn cannot be interrupted", async () => {
    const db = await openFixtureDatabase();
    const provider = new InterruptCaptureProvider({ reject: new Error("interrupt rejected") });
    try {
      insertProject(db, "demo");
      const issueId = insertIssue(db, "demo", "in_progress", "thread-reject", "turn-reject");
      insertOpenRun(db, issueId);

      await expect(retryIssueWithInterrupt(db, issueId, {}, { providers: { codex: provider } }))
        .rejects.toThrow("旧 Session 中断失败");

      expect(getIssue(db, issueId)).toMatchObject({ status: "in_progress" });
      expect(latestRun(db, issueId)).toMatchObject({ status: "in_progress", ended_at: "" });
      expect(eventWithType(db, "issue.interrupt_failed")?.payload).toContain("interrupt rejected");
      expect(eventWithType(db, "issue.interrupted")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("a failed interrupt can be retried with a new lifecycle revision", async () => {
    const db = await openFixtureDatabase();
    const provider = new InterruptCaptureProvider({ reject: new Error("interrupt rejected") });
    try {
      insertProject(db, "demo");
      const issueId = insertIssue(db, "demo", "in_progress", "thread-retry-again", "turn-retry-again");
      insertOpenRun(db, issueId);

      await expect(retryIssueWithInterrupt(db, issueId, {}, { providers: { codex: provider } }))
        .rejects.toThrow("旧 Session 中断失败");
      await expect(retryIssueWithInterrupt(db, issueId, {}, { providers: { codex: provider } }))
        .rejects.toThrow("旧 Session 中断失败");

      expect(provider.interrupts).toHaveLength(2);
      const lifecycleIDs = listEvents(db)
        .filter((event) => event.type === "run.lifecycle.intent.v1")
        .map((event) => JSON.parse(event.payload).event_id);
      expect(lifecycleIDs).toHaveLength(2);
      expect(new Set(lifecycleIDs).size).toBe(2);
    } finally {
      db.close();
    }
  });

  test("a late failure from the interrupted run cannot fail the newly queued attempt", async () => {
    const db = await openFixtureDatabase();
    const provider = new RestartableExecutionProvider();
    try {
      insertProject(db, "demo");
      const issueId = insertIssue(db, "demo", "todo", "", "");
      const running = runProjectLoopOnce({ database: db, projectId: "demo", providers: { codex: provider } });
      await waitFor(() => latestRun(db, issueId)?.provider_session_id === "thread-running");

      const retried = await retryIssueWithInterrupt(db, issueId, {}, { providers: { codex: provider } });
      await running;

      expect(retried.status).toBe("todo");
      expect(getIssue(db, issueId)).toMatchObject({ status: "todo", error: "" });
      expect(latestRun(db, issueId)).toMatchObject({
        status: "cancelled",
        exit_reason: `superseded_by:xw:run:issue_runs:issue-${issueId}-attempt-2`,
        error: ""
      });
    } finally {
      db.close();
    }
  });
});

class InterruptCaptureProvider implements ExecutorProvider {
  readonly id = "codex" as const;
  readonly capabilities = ["interrupt"] as const;
  readonly interrupts: InterruptInput[] = [];

  constructor(private readonly behavior: { hang?: boolean; reject?: Error } = {}) {}

  async run(_input: ProviderRunInput) {
    throw new Error("not implemented");
  }

  async interrupt(input: InterruptInput): Promise<void> {
    this.interrupts.push(input);
    if (this.behavior.reject) throw this.behavior.reject;
    if (this.behavior.hang) return await new Promise(() => {});
  }
}

class RestartableExecutionProvider implements ExecutorProvider {
  readonly id = "codex" as const;
  readonly capabilities = ["issue_execution", "interrupt"] as const;
  private rejectRun?: (error: Error) => void;

  async run(input: ProviderRunInput) {
    input.onEvent?.({
      provider: "codex",
      type: "turn_started",
      status: "inProgress",
      session: { provider: "codex", sessionId: "thread-running", turnId: "turn-running" }
    });
    return await new Promise<never>((_resolve, reject) => {
      this.rejectRun = reject;
    });
  }

  async interrupt(_input: InterruptInput): Promise<void> {
    const rejectRun = this.rejectRun;
    setTimeout(() => rejectRun?.(new Error("old turn interrupted")), 0);
  }
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, projectId: string, status: string, threadID: string, turnID: string): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, codex_thread_id, codex_turn_id, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [projectId, "Interrupt", status, threadID, turnID, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing inserted issue id");
  return row.id;
}

function insertOpenRun(db: RunnerDatabase, issueId: number): void {
  db.sqlite.run(
    `insert into issue_runs (id, issue_id, attempt, status, started_at)
     values (?, ?, ?, ?, ?)`,
    [`issue-${issueId}-attempt-1`, issueId, 1, "in_progress", "2026-01-01T00:00:00Z"]
  );
}

function insertAgentSession(
  db: RunnerDatabase,
  issueID: number,
  projectID: string,
  sessionID: string,
  status: string
): void {
  db.sqlite.run(
    `insert into agent_sessions
      (session_key, provider, provider_session_id, project_id, issue_id, status, raw_ref, created_at, updated_at)
     values (?, 'codex', ?, ?, ?, ?, '{}', ?, ?)`,
    [
      `codex:${sessionID}`,
      sessionID,
      projectID,
      issueID,
      status,
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z"
    ]
  );
}

function latestRun(db: RunnerDatabase, issueId: number): Record<string, unknown> | null {
  return db.sqlite.query<Record<string, unknown>, [number]>(
    `select status, provider_session_id, provider_turn_id, ended_at, exit_reason, error
     from issue_runs where issue_id = ? order by attempt desc limit 1`
  ).get(issueId) ?? null;
}

function latestAttempt(db: RunnerDatabase, issueId: number): Record<string, unknown> | null {
  return db.sqlite.query<Record<string, unknown>, [number]>(`
    select attempt.status, attempt.terminal_reason, attempt.terminal_source_ref
    from run_attempts attempt join issue_runs run on run.id=attempt.issue_run_id
    where run.issue_id=? order by run.attempt desc, attempt.sequence desc limit 1
  `).get(issueId) ?? null;
}

function listEvents(db: RunnerDatabase): Array<{ payload: string; type: string }> {
  return db.sqlite.query<{ payload: string; type: string }, []>(
    "select type, payload from issue_events order by id asc"
  ).all();
}

function eventWithType(db: RunnerDatabase, type: string): { payload: string; type: string } | undefined {
  return listEvents(db).find((event) => event.type === type);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("timed out waiting for condition");
}
