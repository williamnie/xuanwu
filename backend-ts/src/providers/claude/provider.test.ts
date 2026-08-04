import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { listIssueEvents } from "../../db/repositories/issueEvents.ts";
import { getIssue, listIssueRuns } from "../../db/repositories/issues.ts";
import { cancelIssueWithInterrupt } from "../../runner/interrupt.ts";
import { runProjectLoopOnce } from "../../runner/projectLoop.ts";
import { runIssueWithProvider } from "../../runner/providerRuntime.ts";
import { ClaudeExecutorProvider, type ClaudeProcessFactory } from "./provider.ts";

const tempRoots: string[] = [];

describe("Claude Code provider", () => {
  test("keeps CLI fallback explicit and reports its real command readiness", () => {
    const injected = new ClaudeExecutorProvider(runtimeConfig({ mode: "cli-fallback" }), {
      processFactory: scriptedProcessFactory({}).factory
    });
    const missing = new ClaudeExecutorProvider(runtimeConfig({ command: "/definitely/missing/claude", mode: "cli-fallback" }));

    expect(injected.capabilities).toEqual(["issue_execution", "sessions", "resume_session", "interrupt"]);
    expect(injected.runtimeStatus()).toMatchObject({ mode: "cli-fallback", ready: true });
    expect(missing.runtimeStatus()).toMatchObject({ mode: "cli-fallback", ready: false });
  });

  test("creates, discovers, reads, and resumes local Claude Code sessions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "xuanwu-bun-claude-session-cwd-"));
    tempRoots.push(cwd);
    const factory = scriptedProcessFactory({ stdout: jsonl([
      { type: "system", subtype: "init", session_id: "local-session" },
      { type: "result", session_id: "local-session", uuid: "local-turn", is_error: false }
    ]) });
    const sessionInfo = {
      sessionId: "local-session",
      summary: "Local history",
      firstPrompt: "first prompt",
      customTitle: "",
      lastModified: 2_000,
      gitBranch: "main",
      cwd
    };
    const provider = new ClaudeExecutorProvider(runtimeConfig({ authMode: "local-cli", mode: "cli-fallback" }), {
      authInspector: () => ({ checked: true, logged_in: true }),
      processFactory: factory.factory,
      sessionFunctions: {
        listSessions: async () => [sessionInfo],
        getSessionInfo: async () => sessionInfo,
        getSessionMessages: async () => [{
          type: "user",
          uuid: "user-1",
          parent_tool_use_id: null,
          session_id: "local-session",
          message: { role: "user", content: "hello" }
        }]
      }
    });

    expect(await provider.listSessions({ limit: 20 })).toMatchObject({
      data: [{ id: "claude:local-session", provider: "claude", provider_session_id: "local-session" }]
    });
    expect(await provider.readSession("local-session")).toMatchObject({
      id: "claude:local-session",
      cwd,
      turns: [{ items: [{ type: "userMessage", text: "hello" }] }]
    });
    expect(await provider.createSession({ cwd, prompt: "create" })).toMatchObject({
      provider: "claude",
      provider_session_id: "local-session"
    });
    expect(await provider.sendSessionMessage({ sessionId: "local-session", prompt: "continue" })).toMatchObject({
      provider_session_id: "local-session",
      turn_id: "local-turn"
    });
    expect(await provider.recover({
      ...runInput(),
      cwd,
      session: { provider: "claude", sessionId: "local-session", turnId: "local-turn" }
    })).toMatchObject({ session: { sessionId: "local-session", turnId: "local-turn" } });
    expect(factory.calls[0]?.command).not.toContain("--bare");
    expect(factory.calls[1]?.command).toContain("--resume");
    expect(factory.calls[1]?.command).toContain("local-session");
    expect(factory.calls[2]?.command).toContain("--resume");
  });

  test("reports explicit local CLI login and does not pass parent API credentials to Claude", async () => {
    const factory = scriptedProcessFactory({ stdout: jsonl([
      { type: "result", session_id: "local-session", uuid: "local-turn", is_error: false }
    ]) });
    const provider = new ClaudeExecutorProvider(runtimeConfig({
      authMode: "local-cli",
      env: { ANTHROPIC_API_KEY: "configured-api-key-must-not-win" },
      mode: "cli-fallback"
    }), {
      authInspector: () => ({ auth_method: "claude.ai", checked: true, logged_in: true, provider: "firstParty" }),
      processFactory: factory.factory
    });
    expect(provider.runtimeStatus()).toMatchObject({
      auth_configured: true,
      auth_mode: "local-cli",
      auth_source: "local_cli",
      mode: "cli-fallback",
      ready: true
    });
    await provider.run(runInput());
    expect(factory.calls[0]?.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("spawns Claude stream-json CLI and persists provider runtime/events", async () => {
    const db = await openFixtureDatabase();
    const factory = scriptedProcessFactory({
      stdout: jsonl([
        { type: "system", subtype: "init", session_id: "sess-1" },
        { type: "assistant", message: { content: [{ type: "text", text: "hello from claude" }] } },
        { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "xuanwu issue update --id 183 --status done --json" } }] } },
        { type: "result", session_id: "sess-1", uuid: "turn-1", is_error: false, terminal_reason: "end_turn" }
      ])
    });
    try {
      const cwd = await mkdtemp(join(tmpdir(), "xuanwu-bun-claude-cwd-"));
      tempRoots.push(cwd);
      insertProject(db, "demo", cwd);
      const issueId = insertIssue(db, "demo");
      const provider = new ClaudeExecutorProvider(runtimeConfig({ model: "sonnet" }), { processFactory: factory.factory });

      const result = await runIssueWithProvider(provider, {
        database: db,
        issueId,
        projectId: "demo",
        cwd,
        prompt: "issue prompt",
        approvalPolicy: "never",
        sandbox: "workspace-write"
      });

      expect(factory.calls).toHaveLength(1);
      expect(factory.calls[0].cwd).toBe(cwd);
      expect(factory.calls[0].env.XUANWU_MANAGED_EXECUTION).toBe("1");
      expect(factory.calls[0].command).toEqual([
        "claude", "-p", "--verbose", "--output-format", "stream-json",
        "--permission-mode", "dontAsk", "--allowedTools", "Read,Grep,Glob,LS,Edit,MultiEdit,Write,Bash",
        "--model", "sonnet", "--max-turns", "50", "issue prompt"
      ]);
      expect(result).toEqual({ runId: `cli:claude:${issueId}`, session: { provider: "claude", sessionId: "sess-1", turnId: "turn-1" } });
      expect(getIssue(db, issueId)).toMatchObject({ status: "in_progress", codex_thread_id: "", codex_turn_id: "" });
      expect(listIssueRuns(db, issueId)).toMatchObject([{
        provider: "claude",
        provider_session_id: "sess-1",
        provider_turn_id: "turn-1",
        codex_thread_id: "",
        codex_turn_id: "",
        status: "succeeded",
        ended_at: expect.any(String),
        runtime_metadata_json: `{"run_id":"cli:claude:${issueId}"}`
      }]);
      const payloads = listIssueEvents(db, issueId).map((event) => event.payload).join("\n");
      expect(payloads).toContain("hello from claude");
      expect(payloads).toContain("xuanwu issue update");
      expect(payloads).toContain("end_turn");
    } finally {
      db.close();
    }
  });

  test("returns redacted error when Claude exits non-zero", async () => {
    const factory = scriptedProcessFactory({ exitCode: 7, stderr: "ANTHROPIC_API_KEY=fixture-secret\nboom\n" });
    const provider = new ClaudeExecutorProvider(runtimeConfig({ env: { ANTHROPIC_API_KEY: "fixture-secret" } }), { processFactory: factory.factory });

    const error = await rejectedError(provider.run(runInput()));

    expect(error.message).toContain("Claude Code run failed");
    expect(error.message).not.toContain("fixture-secret");
  });


  test("uses read-only allowed tools for read-only sandbox", async () => {
    const factory = scriptedProcessFactory({ stdout: jsonl([
      { type: "result", session_id: "sess-read", uuid: "turn-read", is_error: false }
    ]) });
    const provider = new ClaudeExecutorProvider(runtimeConfig(), { processFactory: factory.factory });

    await provider.run({ ...runInput(), sandbox: "read-only" });

    expect(factory.calls[0].command).toContain("Read,Grep,Glob,LS,Bash(xuanwu issue update:*),Bash(curl:*)");
  });

  test("times out and kills the Claude child process", async () => {
    const factory = hangingProcessFactory();
    const provider = new ClaudeExecutorProvider(runtimeConfig({ timeoutMs: 1 }), { processFactory: factory.factory });

    await expect(provider.run(runInput())).rejects.toThrow("timed out");

    expect(factory.killed).toBe(true);
  });

  test("cancel interrupts the active Claude child process and closes the run", async () => {
    const db = await openFixtureDatabase();
    const factory = hangingProcessFactory();
    const provider = new ClaudeExecutorProvider(runtimeConfig({ timeoutMs: 30_000 }), { processFactory: factory.factory });
    try {
      const cwd = await mkdtemp(join(tmpdir(), "xuanwu-bun-claude-cancel-cwd-"));
      tempRoots.push(cwd);
      insertProject(db, "demo", cwd);
      const issueId = insertIssue(db, "demo");
      const running = runIssueWithProvider(provider, {
        database: db,
        issueId,
        projectId: "demo",
        cwd,
        prompt: "issue prompt"
      });

      await waitFor(() => listIssueRuns(db, issueId)[0]?.provider_session_id === `cli:claude:${issueId}`);
      const issue = await cancelIssueWithInterrupt(db, issueId, {
        interruptTimeoutMs: 50,
        providers: { claude: provider }
      });
      await expect(running).rejects.toThrow("Claude Code run failed: exit code 143");

      expect(factory.killed).toBe(true);
      expect(issue.status).toBe("cancelled");
      expect(getIssue(db, issueId)).toMatchObject({ status: "cancelled", codex_thread_id: "", codex_turn_id: "" });
      expect(listIssueRuns(db, issueId)).toMatchObject([{
        provider: "claude",
        provider_session_id: `cli:claude:${issueId}`,
        provider_turn_id: `cli:claude:${issueId}`,
        codex_thread_id: "",
        codex_turn_id: "",
        status: "failed",
        exit_reason: "provider_reported_failed"
      }]);
      const eventTypes = listIssueEvents(db, issueId).map((event) => event.type);
      expect(eventTypes).toContain("issue.interrupt_requested");
      expect(eventTypes).toContain("issue.interrupted");
    } finally {
      db.close();
    }
  });

  test("cancelled Claude run failure does not pollute the next project loop claim", async () => {
    const db = await openFixtureDatabase();
    const factory = hangingProcessFactory();
    const provider = new ClaudeExecutorProvider(runtimeConfig({ timeoutMs: 30_000 }), { processFactory: factory.factory });
    try {
      const cwd = await mkdtemp(join(tmpdir(), "xuanwu-bun-claude-next-cwd-"));
      tempRoots.push(cwd);
      insertProject(db, "demo", cwd);
      const issueId = insertIssue(db, "demo", "todo");
      const running = runProjectLoopOnce({ database: db, projectId: "demo", providers: { claude: provider } });

      await waitFor(() => listIssueRuns(db, issueId)[0]?.provider_session_id === `cli:claude:${issueId}`);
      await cancelIssueWithInterrupt(db, issueId, {
        interruptTimeoutMs: 50,
        providers: { claude: provider }
      });
      await running;

      expect(getIssue(db, issueId)).toMatchObject({ status: "cancelled", error: "" });
      expect(listIssueRuns(db, issueId)[0]).toMatchObject({
        status: "failed",
        exit_reason: "provider_reported_failed",
        error: expect.stringContaining("missing result event")
      });
    } finally {
      db.close();
    }
  });
});

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

function runtimeConfig(overrides: Partial<ProviderRuntimeConfig> = {}): ProviderRuntimeConfig {
  return {
    command: "claude",
    cwd: "",
    env: {},
    timeoutMs: 30_000,
    ...overrides
  };
}

function runInput() {
  return { issueId: 183, projectId: "demo", cwd: "/tmp", prompt: "issue prompt" };
}

async function rejectedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("expected promise to reject");
}

function scriptedProcessFactory(input: { exitCode?: number; stderr?: string; stdout?: string }) {
  const calls: Array<{ command: string[]; cwd?: string; env: Record<string, string | undefined> }> = [];
  const factory: ClaudeProcessFactory = (call) => {
    calls.push(call);
    return {
      stdout: streamFrom(input.stdout ?? ""),
      stderr: streamFrom(input.stderr ?? ""),
      exited: Promise.resolve(input.exitCode ?? 0),
      kill: () => undefined
    };
  };
  return { calls, factory };
}

function hangingProcessFactory() {
  let killed = false;
  let closeStdout: (() => void) | undefined;
  let closeStderr: (() => void) | undefined;
  let resolveExit: ((code: number) => void) | undefined;
  const factory: ClaudeProcessFactory = () => ({
    stdout: closableStream((close) => { closeStdout = close; }),
    stderr: closableStream((close) => { closeStderr = close; }),
    exited: new Promise<number>((resolve) => { resolveExit = resolve; }),
    kill: () => {
      killed = true;
      closeStdout?.();
      closeStderr?.();
      resolveExit?.(143);
    }
  });
  return { factory, get killed() { return killed; } };
}

function streamFrom(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (text !== "") controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    }
  });
}

function closableStream(register: (close: () => void) => void): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { register(() => controller.close()); } });
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition timed out");
}

function jsonl(records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-bun-claude-provider-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase, id: string, cwd: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [id, id, cwd, "claude", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, projectId: string, status = "in_progress"): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, issue_log_mode, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [projectId, "Claude runtime", status, "debug", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing inserted issue id");
  return row.id;
}
