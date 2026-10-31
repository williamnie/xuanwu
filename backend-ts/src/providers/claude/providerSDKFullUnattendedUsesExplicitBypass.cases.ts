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

export function registerSDKFullUnattendedUsesExplicitBypass() {
test("SDK full unattended uses explicit bypass and ask modes install a host callback", async () => {
    for (const request of [
      { access: "unrestricted-host", approval: "unattended" },
      { access: "unrestricted-host", approval: "ask-every-side-effect" }
    ] as const) {
      let captured: ClaudeSdkOptions | undefined;
      const provider = new ClaudeSdkExecutorProvider(runtimeConfig({ mode: "sdk" }), {
        queryFactory: ({ options }) => {
          captured = options;
          return (async function* () {})();
        }
      });
      await provider.run({ ...runInput(), policy: claudePolicy(request) }).catch(() => undefined);
      if (request.approval === "unattended") {
        expect(captured).toMatchObject({ allowDangerouslySkipPermissions: true, permissionMode: "bypassPermissions" });
      } else {
        expect(captured?.permissionMode).toBe("default");
        expect(typeof captured?.canUseTool).toBe("function");
        expect(captured?.allowedTools).toEqual(["Read", "Grep", "Glob"]);
      }
    }
  });

test("SDK local login keeps unattended native development inside the host tool gate", async () => {
    let captured: ClaudeSdkOptions | undefined;
    const provider = new ClaudeSdkExecutorProvider(runtimeConfig({ authMode: "local-cli", mode: "sdk" }), {
      authInspector: () => ({ auth_method: "oauth_token", checked: true, logged_in: true, provider: "firstParty" }),
      queryFactory: ({ options }) => {
        captured = options;
        return (async function* () {})();
      }
    });

    await provider.run({
      ...runInput(),
      policy: claudePolicy({ access: "provider-native-development", approval: "unattended" })
    }).catch(() => undefined);

    expect(provider.runtimeStatus()).toMatchObject({
      auth_mode: "local-cli",
      auth_source: "local_cli",
      mode: "sdk",
      ready: true
    });
    expect(captured).toMatchObject({
      allowedTools: ["Read", "Grep", "Glob"],
      permissionMode: "default",
      tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"]
    });
    expect(captured?.allowDangerouslySkipPermissions).toBeUndefined();
    expect(typeof captured?.canUseTool).toBe("function");
  });

test("keeps CLI fallback explicit and reports its real command readiness", () => {
    const injected = new ClaudeExecutorProvider(runtimeConfig({ mode: "cli-fallback" }), {
      processFactory: scriptedProcessFactory({}).factory
    });
    const missing = new ClaudeExecutorProvider(runtimeConfig({ command: "/definitely/missing/claude", mode: "cli-fallback" }));

    expect(injected.capabilities).toEqual(["issue_execution", "sessions", "resume_session", "interrupt"]);
    expect(injected.runtimeStatus()).toMatchObject({ mode: "cli-fallback", ready: true });
    expect(missing.runtimeStatus()).toMatchObject({ mode: "cli-fallback", ready: false });
  });

test("only blocks local CLI execution when the auth probe explicitly reports logged out", () => {
    const inconclusive = new ClaudeExecutorProvider(runtimeConfig({ command: process.execPath, mode: "cli-fallback" }), {
      authInspector: () => ({ checked: false, logged_in: false })
    });
    const loggedOut = new ClaudeExecutorProvider(runtimeConfig({ command: process.execPath, mode: "cli-fallback" }), {
      authInspector: () => ({ checked: true, logged_in: false })
    });

    expect(inconclusive.runtimeStatus()).toMatchObject({
      auth_configured: false,
      auth_source: "local_cli",
      ready: true
    });
    expect(inconclusive.runtimeStatus().reason).toBeUndefined();
    expect(loggedOut.runtimeStatus()).toMatchObject({
      auth_configured: false,
      auth_source: "local_cli",
      ready: false,
      reason: "Claude CLI local login is unavailable; run `claude auth login` as the service user"
    });
  });

test("treats a parsed logged-out response as authoritative even when the CLI exits non-zero", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-claude-auth-probe-"));
    tempRoots.push(root);
    const loggedOutCommand = join(root, "claude-logged-out");
    const invalidCommand = join(root, "claude-invalid-status");
    await writeFile(
      loggedOutCommand,
      "#!/bin/sh\nprintf '%s\\n' '{\"loggedIn\":false,\"authMethod\":\"none\",\"apiProvider\":\"firstParty\"}'\nexit 1\n",
      { mode: 0o700 }
    );
    await writeFile(invalidCommand, "#!/bin/sh\nprintf '%s\\n' 'status unavailable'\nexit 1\n", { mode: 0o700 });

    expect(inspectClaudeCliAuth(runtimeConfig({ command: loggedOutCommand }))).toMatchObject({
      checked: true,
      logged_in: false,
      provider: "firstParty"
    });
    expect(inspectClaudeCliAuth(runtimeConfig({ command: invalidCommand }))).toEqual({
      checked: false,
      logged_in: false
    });
  });

test("CLI fallback honors metadata-only and enforces history source budget", async () => {
    let messageReads = 0;
    const provider = new ClaudeExecutorProvider(runtimeConfig({ authMode: "local-cli", mode: "cli-fallback" }), {
      authInspector: () => ({ checked: true, logged_in: true }),
      processFactory: scriptedProcessFactory({ stdout: "" }).factory,
      sessionFunctions: {
        getSessionInfo: async () => ({ sessionId: "metadata", summary: "Large history", cwd: "/tmp/project", lastModified: 0, fileSize: 64 * 1024 * 1024 + 1 }),
        getSessionMessages: async () => { messageReads++; throw new Error("must not load history"); },
      },
    });
    expect(await provider.readSession("metadata", { includeTurns: false })).toMatchObject({
      id: "claude:metadata", name: "Large history", cwd: "/tmp/project", turns: [],
    });
    await expect(provider.readSession("metadata", { includeTurns: true })).rejects.toThrow("64 MiB source limit");
    expect(messageReads).toBe(0);
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
      sessionIdFactory: () => "local-session",
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
      turns: [{ items: [{ type: "userMessage", content: [{ type: "input_text", text: "hello" }] }] }]
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
}
