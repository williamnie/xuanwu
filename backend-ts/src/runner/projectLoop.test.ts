import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getAgentSession } from "../db/repositories/agentSessions.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { runProjectLoopOnce } from "./projectLoop.ts";
import { startProjectLoop } from "./projectLoopManager.ts";
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

class FailingExecutionProvider extends FakeExecutionProvider {
  async run(input: ProviderRunInput) {
    this.inputs.push(input);
    throw new Error("provider failed CODEX_API_KEY=fixture-secret");
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

  test("does not claim another todo while any executor run is still open", async () => {
    const db = await openFixtureDatabase();
    const provider = new FakeExecutionProvider();
    try {
      insertProject(db, { id: "demo", provider: provider.id });
      insertProject(db, { id: "other", provider: provider.id });
      const running = insertIssue(db, { projectId: "demo", title: "running", status: "in_progress" });
      const waiting = insertIssue(db, { projectId: "other", title: "waiting" });
      insertOpenRun(db, running);

      const result = await runProjectLoopOnce({ database: db, projectId: "other", providers: { [provider.id]: provider } });

      expect(result).toEqual({ claimed: false });
      expect(provider.inputs).toEqual([]);
      expect(getIssue(db, waiting)).toMatchObject({ status: "todo", attempt_count: 0 });
      expect(listIssueRuns(db, waiting)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("auto-run loop starts one session and leaves remaining todos queued", async () => {
    const db = await openFixtureDatabase();
    const provider = new FakeExecutionProvider();
    try {
      insertProject(db, { id: "serial-demo", provider: provider.id, autoRun: 1 });
      const first = insertIssue(db, { projectId: "serial-demo", title: "first" });
      const second = insertIssue(db, { projectId: "serial-demo", title: "second" });

      startProjectLoop({ database: db, providers: { [provider.id]: provider } }, "serial-demo");
      await waitFor(() => provider.inputs.length === 1);
      await Bun.sleep(20);

      expect(provider.inputs.map((input) => input.issueId)).toEqual([first]);
      expect(getIssue(db, first)).toMatchObject({ status: "in_progress", attempt_count: 1 });
      expect(getIssue(db, second)).toMatchObject({ status: "todo", attempt_count: 0 });
      expect(listIssueRuns(db, second)).toEqual([]);
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

  test("marks provider failures failed and closes the open run with redacted error", async () => {
    const db = await openFixtureDatabase();
    const provider = new FailingExecutionProvider();
    try {
      insertProject(db, { id: "demo", provider: provider.id });
      const issueId = insertIssue(db, { projectId: "demo", title: "provider fails" });

      await runProjectLoopOnce({ database: db, projectId: "demo", providers: { [provider.id]: provider } });

      const issue = getIssue(db, issueId);
      const run = listIssueRuns(db, issueId).at(-1);
      expect(issue).toMatchObject({
        status: "failed",
        error: "provider failed CODEX_API_KEY=[redacted]"
      });
      expect(issue?.error).not.toContain("fixture-secret");
      expect(run).toMatchObject({
        status: "failed",
        exit_reason: "failed",
        error: "provider failed CODEX_API_KEY=[redacted]"
      });
      expect(run?.ended_at).not.toBe("");
    } finally {
      db.close();
    }
  });
});

type ProjectFixture = { autoRun?: number; id: string; provider: string };

type IssueFixture = {
  createdAt?: string;
  priority?: number;
  projectId: string;
  status?: string;
  title: string;
};

function insertProject(db: RunnerDatabase, project: ProjectFixture): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [project.id, project.id, `/tmp/${project.id}`, project.provider, project.autoRun ?? 0,
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
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

function insertOpenRun(db: RunnerDatabase, issueID: number): void {
  db.sqlite.run(
    `insert into issue_runs (id, issue_id, attempt, status, started_at)
     values (?, ?, ?, ?, ?)`,
    [`issue-${issueID}-attempt-1`, issueID, 1, "in_progress", "2026-01-01T00:00:00Z"]
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition timed out");
}
