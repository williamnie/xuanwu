import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { cancelIssueWithInterrupt } from "./interrupt.ts";
import type { ExecutorProvider, InterruptInput, ProviderRunInput } from "../providers/types.ts";

const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-interrupt-"));
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
