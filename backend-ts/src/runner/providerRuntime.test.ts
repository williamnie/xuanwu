import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getAgentSession } from "../db/repositories/agentSessions.ts";
import { listIssueRuns } from "../db/repositories/issues.ts";
import { runIssueWithProvider } from "./providerRuntime.ts";
import { isExecutorProviderId } from "../providers/types.ts";
import type { ExecutorProvider, ProviderEvent, ProviderRunInput } from "../providers/types.ts";

const tempRoots: string[] = [];

class FakeExecutionProvider implements ExecutorProvider {
  readonly id = "fake-execution-only" as const;
  readonly capabilities = ["issue_execution"] as const;
  lastInput?: ProviderRunInput;

  async run(input: ProviderRunInput) {
    this.lastInput = input;
    input.onEvent?.({
      provider: this.id,
      type: "provider.message",
      session: { provider: this.id, sessionId: "fake-session", turnId: "fake-turn" },
      text: "fake provider log"
    });
    return {
      runId: "fake-run",
      session: { provider: this.id, sessionId: "fake-session", turnId: "fake-turn" }
    };
  }
}

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-provider-runtime-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("executor provider runtime seam", () => {
  test("PI is not modeled as an executor provider id", () => {
    expect(isExecutorProviderId("pi")).toBe(false);
  });

  test("runner layer can execute a fake provider and observe session refs/events", async () => {
    const provider = new FakeExecutionProvider();
    const events: ProviderEvent[] = [];

    const result = await runIssueWithProvider(provider, {
      issueId: 154,
      projectId: "codex-issue-runner",
      cwd: "/tmp/project",
      prompt: "issue prompt",
      model: "codex-default",
      approvalPolicy: "never",
      sandbox: "workspace-write",
      onLog: (event) => events.push(event)
    });

    expect(provider.lastInput).toMatchObject({ issueId: 154, projectId: "codex-issue-runner" });
    expect(result).toEqual({
      runId: "fake-run",
      session: { provider: "fake-execution-only", sessionId: "fake-session", turnId: "fake-turn" }
    });
    expect(events).toEqual([{
      provider: "fake-execution-only",
      type: "provider.message",
      text: "fake provider log",
      session: result.session
    }]);
  });

  test("runtime hooks persist start, events, and final provider session refs", async () => {
    const provider = new FakeExecutionProvider();
    const calls: Array<[string, unknown]> = [];

    const result = await runIssueWithProvider(provider, {
      issueId: 159,
      projectId: "demo",
      cwd: "/tmp/project",
      prompt: "issue prompt",
      onRunStart: (input) => calls.push(["start", input]),
      onRuntimeEvent: (event) => calls.push(["event", event]),
      onRunComplete: (output) => calls.push(["complete", output])
    });

    expect(result.session).toEqual({ provider: "fake-execution-only", sessionId: "fake-session", turnId: "fake-turn" });
    expect(calls).toEqual([
      ["start", { provider: "fake-execution-only", issueId: 159, projectId: "demo", metadata: { cwd: "/tmp/project" } }],
      ["event", {
        provider: "fake-execution-only",
        type: "provider.message",
        text: "fake provider log",
        session: result.session
      }],
      ["complete", {
        provider: "fake-execution-only",
        issueId: 159,
        projectId: "demo",
        runId: "fake-run",
        session: result.session
      }]
    ]);
  });

  test("persists provider session refs into issue_runs and agent_sessions", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const issueId = insertIssue(db, "demo");

      await runIssueWithProvider(new FakeExecutionProvider(), {
        database: db,
        issueId,
        projectId: "demo",
        cwd: "/tmp/project",
        prompt: "issue prompt"
      });

      expect(listIssueRuns(db, issueId)).toMatchObject([{
        attempt: 1,
        provider: "fake-execution-only",
        provider_session_id: "fake-session",
        provider_turn_id: "fake-turn",
        codex_thread_id: "",
        codex_turn_id: "",
        runtime_metadata_json: "{\"run_id\":\"fake-run\"}"
      }]);
      expect(getAgentSession(db, "fake-execution-only:fake-session")).toMatchObject({
        provider: "fake-execution-only",
        provider_session_id: "fake-session",
        project_id: "demo",
        issue_id: issueId,
        raw_ref: "{\"provider_turn_id\":\"fake-turn\",\"run_id\":\"fake-run\"}"
      });
    } finally {
      db.close();
    }
  });
});

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, projectId: string): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, created_at, updated_at)
     values (?, ?, ?, ?, ?)`,
    [projectId, "Runtime", "in_progress", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing inserted issue id");
  return row.id;
}
