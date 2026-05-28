import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getAgentSession } from "../db/repositories/agentSessions.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { runProjectLoopOnce } from "./projectLoop.ts";
import type { ExecutorProvider, ProviderRunInput } from "../providers/types.ts";

const tempRoots: string[] = [];

class FakeExecutionProvider implements ExecutorProvider {
  readonly id = "fake-execution-only" as const;
  readonly capabilities = ["issue_execution"] as const;
  readonly inputs: ProviderRunInput[] = [];

  async run(input: ProviderRunInput) {
    this.inputs.push(input);
    input.onEvent?.({
      provider: this.id,
      type: "provider.message",
      text: "fake started",
      session: { provider: this.id, sessionId: `fake-session-${input.issueId}`, turnId: `fake-turn-${input.issueId}` }
    });
    return {
      runId: `fake-run-${input.issueId}`,
      session: { provider: this.id, sessionId: `fake-session-${input.issueId}`, turnId: `fake-turn-${input.issueId}` }
    };
  }
}

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-project-loop-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun project loop claim execution", () => {
  test("claims a single todo issue by runner order and starts provider run", async () => {
    const db = await openFixtureDatabase();
    const provider = new FakeExecutionProvider();
    try {
      insertProject(db, { id: "demo", provider: provider.id });
      const laterHigh = insertIssue(db, { projectId: "demo", title: "later high", priority: 5, createdAt: "2026-01-03T00:00:00Z" });
      const firstHigh = insertIssue(db, { projectId: "demo", title: "first high", priority: 5, createdAt: "2026-01-02T00:00:00Z" });
      const low = insertIssue(db, { projectId: "demo", title: "low", priority: 1, createdAt: "2026-01-01T00:00:00Z" });

      const result = await runProjectLoopOnce({ database: db, projectId: "demo", providers: { [provider.id]: provider } });

      expect(result.claimed).toBe(true);
      if (!result.claimed) throw new Error("expected claim");
      expect(result.issue.id).toBe(firstHigh);
      expect(provider.inputs).toHaveLength(1);
      expect(provider.inputs[0]).toMatchObject({ issueId: firstHigh, projectId: "demo", prompt: "first high" });
      expect(getIssue(db, firstHigh)).toMatchObject({ status: "in_progress", attempt_count: 1 });
      expect(getIssue(db, laterHigh)).toMatchObject({ status: "todo" });
      expect(getIssue(db, low)).toMatchObject({ status: "todo" });
      expect(listIssueRuns(db, firstHigh)).toMatchObject([{
        attempt: 1,
        status: "in_progress",
        provider: "fake-execution-only",
        provider_session_id: `fake-session-${firstHigh}`,
        provider_turn_id: `fake-turn-${firstHigh}`,
        runtime_metadata_json: `{"run_id":"fake-run-${firstHigh}"}`,
        ended_at: ""
      }]);
      expect(getAgentSession(db, `fake-execution-only:fake-session-${firstHigh}`)).toMatchObject({
        provider: "fake-execution-only",
        provider_session_id: `fake-session-${firstHigh}`,
        issue_id: firstHigh,
        status: "completed"
      });
    } finally {
      db.close();
    }
  });

  test("idles safely when there are no todo issues", async () => {
    const db = await openFixtureDatabase();
    const provider = new FakeExecutionProvider();
    try {
      insertProject(db, { id: "demo", provider: provider.id });
      insertIssue(db, { projectId: "demo", title: "triage", status: "triage" });

      const result = await runProjectLoopOnce({ database: db, projectId: "demo", providers: { [provider.id]: provider } });

      expect(result).toEqual({ claimed: false });
      expect(provider.inputs).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("keeps issue in progress after provider run completes", async () => {
    const db = await openFixtureDatabase();
    const provider = new FakeExecutionProvider();
    try {
      insertProject(db, { id: "demo", provider: provider.id });
      const issueId = insertIssue(db, { projectId: "demo", title: "needs explicit status" });

      await runProjectLoopOnce({ database: db, projectId: "demo", providers: { [provider.id]: provider } });

      expect(getIssue(db, issueId)).toMatchObject({ status: "in_progress" });
      expect(listIssueRuns(db, issueId)).toMatchObject([{ status: "in_progress", ended_at: "" }]);
    } finally {
      db.close();
    }
  });
});

type ProjectFixture = { id: string; provider: string };

type IssueFixture = {
  createdAt?: string;
  priority?: number;
  projectId: string;
  status?: string;
  title: string;
};

function insertProject(db: RunnerDatabase, project: ProjectFixture): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [project.id, project.id, `/tmp/${project.id}`, project.provider, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, issue: IssueFixture): number {
  const status = issue.status ?? "todo";
  const priority = issue.priority ?? 0;
  const createdAt = issue.createdAt ?? "2026-01-01T00:00:00Z";
  db.sqlite.run(
    `insert into issues (project_id, title, status, priority, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [issue.projectId, issue.title, status, priority, createdAt, createdAt]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing inserted issue id");
  return row.id;
}
