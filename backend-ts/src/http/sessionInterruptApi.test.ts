import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { upsertAgentSession } from "../db/repositories/agentSessions.ts";
import { createDefaultRouter } from "./server.ts";
import type { ExecutorProvider, InterruptInput, ProviderRunInput } from "../providers/types.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-session-interrupt-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun session interrupt API", () => {
  test("interrupts a persisted Codex session turn without mutating issues", async () => {
    const database = await openFixtureDatabase();
    const provider = new InterruptCaptureProvider();
    try {
      upsertAgentSession(database, {
        provider: "codex",
        provider_session_id: "thread-manual",
        raw_ref: { provider_turn_id: "turn-manual" },
        status: "running"
      });

      const response = await createDefaultRouter({
        database,
        providers: { codex: provider }
      }).handle(new Request(`${BASE_URL}/api/sessions/codex:thread-manual/interrupt`, { method: "POST" }));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ interrupted: true });
      expect(provider.interrupts).toEqual([{
        session: { provider: "codex", sessionId: "thread-manual", turnId: "turn-manual" },
        reason: "session_interrupt"
      }]);
    } finally {
      database.close();
    }
  });

  test("interrupts an issue-linked session turn without cancelling the issue", async () => {
    const database = await openFixtureDatabase();
    const provider = new InterruptCaptureProvider();
    try {
      insertProject(database, "demo");
      const issueID = insertIssue(database, "demo", "in_progress", "thread-linked", "turn-linked");
      insertOpenRun(database, issueID);

      const response = await createDefaultRouter({
        database,
        providers: { codex: provider }
      }).handle(new Request(`${BASE_URL}/api/sessions/codex:thread-linked/interrupt`, { method: "POST" }));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ interrupted: true });
      expect(provider.interrupts).toEqual([{
        session: { provider: "codex", sessionId: "thread-linked", turnId: "turn-linked" },
        reason: "session_interrupt"
      }]);
      expect(issueStatus(database, issueID)).toBe("in_progress");
      expect(latestRun(database, issueID)).toMatchObject({
        ended_at: "",
        exit_reason: "",
        status: "in_progress"
      });
    } finally {
      database.close();
    }
  });

  test("retry endpoint interrupts an issue-linked turn before requeueing it", async () => {
    const database = await openFixtureDatabase();
    const provider = new InterruptCaptureProvider();
    try {
      insertProject(database, "demo");
      const issueID = insertIssue(database, "demo", "in_progress", "thread-linked", "turn-linked");
      insertOpenRun(database, issueID);

      const response = await createDefaultRouter({
        database,
        providers: { codex: provider }
      }).handle(new Request(`${BASE_URL}/api/issues/${issueID}/retry`, { method: "POST" }));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: issueID, status: "todo" });
      expect(provider.interrupts).toEqual([{
        session: { provider: "codex", sessionId: "thread-linked", turnId: "turn-linked" },
        reason: "issue_retry"
      }]);
      expect(issueStatus(database, issueID)).toBe("todo");
      expect(latestRun(database, issueID)).toMatchObject({
        status: "cancelled",
        exit_reason: `superseded_by:xw:run:issue_runs:issue-${issueID}-attempt-2`
      });
    } finally {
      database.close();
    }
  });
});

class InterruptCaptureProvider implements ExecutorProvider {
  readonly id = "codex" as const;
  readonly capabilities = ["interrupt"] as const;
  readonly interrupts: InterruptInput[] = [];

  async run(_input: ProviderRunInput) {
    throw new Error("not implemented");
  }

  async interrupt(input: InterruptInput): Promise<void> {
    this.interrupts.push(input);
  }
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, projectID: string, status: string, threadID: string, turnID: string): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, codex_thread_id, codex_turn_id, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [projectID, "Linked session interrupt", status, threadID, turnID, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing inserted issue id");
  return row.id;
}

function insertOpenRun(db: RunnerDatabase, issueID: number): void {
  db.sqlite.run(
    `insert into issue_runs
      (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id, started_at, ended_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [`issue-${issueID}-attempt-1`, issueID, 1, "in_progress", "codex",
      "thread-linked", "turn-linked", "2026-01-01T00:00:00Z", ""]
  );
}

function issueStatus(db: RunnerDatabase, issueID: number): string {
  return db.sqlite.query<{ status: string }, [number]>(
    "select status from issues where id=?"
  ).get(issueID)?.status ?? "";
}

function latestRun(db: RunnerDatabase, issueID: number): Record<string, unknown> | null {
  return db.sqlite.query<Record<string, unknown>, [number]>(
    "select status, ended_at, exit_reason from issue_runs where issue_id=? order by attempt desc limit 1"
  ).get(issueID) ?? null;
}
