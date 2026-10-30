import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createIssueRun } from "../../db/repositories/issueRuns.ts";
import { listIssueEvents } from "../../db/repositories/issueEvents.ts";
import { getIssue, listIssueRuns } from "../../db/repositories/issues.ts";
import { cancelIssueWithInterrupt } from "../../runner/interrupt.ts";
import { runProjectLoopOnce } from "../../runner/projectLoop.ts";
import { runIssueWithProvider } from "../../runner/providerRuntime.ts";
import { ClaudeExecutorProvider, ClaudeSdkExecutorProvider, type ClaudeProcessFactory } from "./provider.ts";
import { inspectClaudeCliAuth } from "./cliProvider.ts";
import type { Options as ClaudeSdkOptions } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_EXECUTION_POLICY_CAPABILITIES, claudeExecutionPolicyAdapter } from "./executionPolicy.ts";
import { resolveExecutionPolicy } from "../core/policyResolution.ts";

import { tempRoots, runtimeConfig, runInput, claudePolicy, rejectedError, scriptedProcessFactory, hangingProcessFactory, stubbornProcessFactory, streamFrom, closableStream, waitFor, jsonl, openFixtureDatabase, insertProject, insertIssue } from "./providerTestFixtures.ts";

export function registerReportsExplicitLocalCLILoginAnd() {
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
      processFactory: factory.factory,
      sessionIdFactory: () => "local-session"
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
    const cwd = await mkdtemp(join(tmpdir(), "xuanwu-bun-claude-cwd-"));
    tempRoots.push(cwd);
    insertProject(db, "demo", cwd);
    const issueId = insertIssue(db, "demo");
    const issueRunId = createIssueRun(db, issueId).id;
    const provider = new ClaudeExecutorProvider(runtimeConfig({ model: "sonnet" }), {
      processFactory: factory.factory,
      sessionIdFactory: () => "sess-1"
    });

    const result = await runIssueWithProvider(provider, {
      database: db,
      issueId,
      issueRunId,
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
      "--session-id", "sess-1",
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
      runtime_metadata_json: JSON.stringify({
        run_id: `cli:claude:${issueId}`,
        resolved_settings: {
          approval_policy: "never",
          model: "",
          reasoning_effort: "",
          sandbox: "workspace-write",
          service_tier: "",
          service_tier_source: "standard"
        }
      })
    }]);
    const payloads = listIssueEvents(db, issueId).map((event) => event.payload).join("\n");
    expect(payloads).toContain("hello from claude");
    expect(payloads).toContain("xuanwu issue update");
    expect(payloads).toContain("end_turn");
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
    const provider = new ClaudeExecutorProvider(runtimeConfig(), {
      processFactory: factory.factory,
      sessionIdFactory: () => "sess-read"
    });

    await provider.run({ ...runInput(), sandbox: "read-only" });

    expect(factory.calls[0].command).toContain("Read,Grep,Glob,LS");
    expect(factory.calls[0].command.join(" ")).not.toContain("xuanwu issue update");
    expect(factory.calls[0].command.join(" ")).not.toContain("Bash(curl:*)");
  });

test("times out and kills the Claude child process", async () => {
    const factory = hangingProcessFactory();
    const provider = new ClaudeExecutorProvider(runtimeConfig({ timeoutMs: 1 }), { processFactory: factory.factory });

    await expect(provider.run(runInput())).rejects.toThrow("timed out");

    expect(factory.killed).toBe(true);
  });

test("escalates a host interrupt when the Claude child ignores SIGTERM", async () => {
    const factory = stubbornProcessFactory();
    const provider = new ClaudeExecutorProvider(runtimeConfig({ timeoutMs: 30_000 }), {
      processFactory: factory.factory,
      sessionIdFactory: () => "session-stubborn"
    });
    const running = provider.run(runInput());
    await waitFor(() => provider.runtimeStatus().active_sessions === 1);

    await provider.interrupt({
      reason: "issue_cancel",
      session: { provider: "claude", sessionId: "session-stubborn" }
    });

    await expect(running).rejects.toThrow("issue_cancel");
    expect(factory.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

test("cancel interrupts the active Claude child process and closes the run", async () => {
    const db = await openFixtureDatabase();
    const factory = hangingProcessFactory();
    const provider = new ClaudeExecutorProvider(runtimeConfig({ timeoutMs: 30_000 }), {
      processFactory: factory.factory,
      sessionIdFactory: () => "session-cancel"
    });
    const cwd = await mkdtemp(join(tmpdir(), "xuanwu-bun-claude-cancel-cwd-"));
    tempRoots.push(cwd);
    insertProject(db, "demo", cwd);
    const issueId = insertIssue(db, "demo");
    const issueRunId = createIssueRun(db, issueId).id;
    const running = runIssueWithProvider(provider, {
      database: db,
      issueId,
      issueRunId,
      projectId: "demo",
      cwd,
      prompt: "issue prompt"
    });

    await waitFor(() => listIssueRuns(db, issueId)[0]?.provider_session_id === "session-cancel");
    const issue = await cancelIssueWithInterrupt(db, issueId, {
      interruptTimeoutMs: 50,
      providers: { claude: provider }
    });
    await expect(running).rejects.toThrow("issue_cancel");

    expect(factory.killed).toBe(true);
    expect(issue.status).toBe("cancelled");
    expect(getIssue(db, issueId)).toMatchObject({ status: "cancelled", codex_thread_id: "", codex_turn_id: "" });
    expect(listIssueRuns(db, issueId)).toMatchObject([{
      provider: "claude",
      provider_session_id: "session-cancel",
      provider_turn_id: "",
      codex_thread_id: "",
      codex_turn_id: "",
      status: "cancelled",
      exit_reason: "issue_cancel",
      error: ""
    }]);
    const eventTypes = listIssueEvents(db, issueId).map((event) => event.type);
    expect(eventTypes).toContain("issue.interrupt_requested");
    expect(eventTypes).toContain("issue.interrupted");
  });
}
