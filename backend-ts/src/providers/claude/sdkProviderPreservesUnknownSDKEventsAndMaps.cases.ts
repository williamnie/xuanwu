import { describe, expect, test } from "bun:test";
import { CLAUDE_AGENT_SDK_VERSION, ClaudeSdkExecutorProvider, type ClaudeQuery, type ClaudeQueryFactory } from "./provider.ts";
import type { ProviderEvent } from "../types.ts";

import { cwd, sdkProvider, config, baseConfig, runInput, init, success, fromMessages, waitingQuery, waitFor } from "./sdkProviderTestFixtures.ts";

export function registerPreservesUnknownSDKEventsAndMaps() {
test("preserves unknown SDK events and maps provider result errors", async () => {
    const events: ProviderEvent[] = [];
    const provider = sdkProvider("session-error", async function* () {
      yield init("session-error", "turn-error");
      yield { type: "future_event", session_id: "session-error", uuid: "turn-error", secret: "sk-ant-secret" };
      yield {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["tool failed"],
        session_id: "session-error",
        uuid: "turn-error",
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 }
      };
    });

    await expect(provider.run(runInput((event) => events.push(event)))).rejects.toThrow("Claude SDK query failed");
    expect(events[2]).toMatchObject({ type: "unknown", raw: { method: "future_event" }, runEvent: { kind: "unknown" } });
    expect(String(events[2]?.raw?.payload)).not.toContain("sk-ant-secret");
    expect(events.at(-1)).toMatchObject({ type: "error", error: "tool failed", runEvent: { kind: "error", outcome: "failed", terminal: true } });
    expect(provider.runtimeStatus().active_sessions).toBe(0);
  });

test("redacts SDK retry, tool input, and tool output before provider events can be persisted", async () => {
    const events: ProviderEvent[] = [];
    const secret = "sk-live-sdk-event-secret";
    const provider = new ClaudeSdkExecutorProvider(config({ env: { ANTHROPIC_API_KEY: secret } }), {
      queryFactory: (() => (async function* () {
      yield init("session-redaction", "turn-init");
      yield {
        type: "system",
        subtype: "api_retry",
        session_id: "session-redaction",
        uuid: "retry-1",
        error: `ANTHROPIC_API_KEY=${secret}`
      };
      yield {
        type: "assistant",
        session_id: "session-redaction",
        uuid: "tool-1",
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: `echo ${secret}`, api_key: secret } }] }
      };
      yield {
        type: "user",
        session_id: "session-redaction",
        uuid: "tool-result-1",
        message: { content: [{ type: "tool_result", content: [{ type: "text", text: `token is ${secret}` }] }] }
      };
      yield success("session-redaction", "turn-result");
      })() as ClaudeQuery) as ClaudeQueryFactory,
      sessionIdFactory: () => "session-redaction"
    });

    await provider.run(runInput((event) => events.push(event)));
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[redacted]");
  });

test("lists and reads Claude SDK sessions through injected session functions", async () => {
    const provider = new ClaudeSdkExecutorProvider(config(), {
      queryFactory: (() => fromMessages([])) as ClaudeQueryFactory,
      sessionFunctions: {
        listSessions: async () => [{
          sessionId: "session-history",
          summary: "History",
          firstPrompt: "first",
          customTitle: "",
          lastModified: 2_000,
          gitBranch: "main",
          cwd
        }],
        getSessionInfo: async () => ({
          sessionId: "session-history",
          summary: "History",
          firstPrompt: "first",
          customTitle: "",
          lastModified: 2_000,
          gitBranch: "main",
          cwd
        }),
        getSessionMessages: async () => [
          { type: "user", uuid: "user-1", parent_tool_use_id: null, session_id: "session-history", message: { role: "user", content: "hello" } },
          { type: "assistant", uuid: "assistant-1", parent_tool_use_id: null, session_id: "session-history", message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } }] } },
          { type: "user", uuid: "tool-result-1", parent_tool_use_id: "tool-1", session_id: "session-history", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "README content" }] } },
          { type: "assistant", uuid: "assistant-2", parent_tool_use_id: null, session_id: "session-history", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }
        ]
      }
    });

    expect(await provider.listSessions({ limit: 20 })).toMatchObject({
      data: [{ id: "claude:session-history", provider: "claude", provider_session_id: "session-history" }],
      nextCursor: ""
    });
    const detail = await provider.readSession("session-history") as {
      turns: Array<{ items: Array<Record<string, unknown> & { type: string }> }>;
    } & Record<string, unknown>;
    expect(detail).toMatchObject({
      session_contract: "xw.provider-session.v1",
      id: "claude:session-history",
      provider: "claude",
      model: "claude-sonnet-4-5",
      cwd
    });
    expect(detail.turns).toHaveLength(1);
    expect(detail.turns[0]?.items.map((item) => item.type)).toEqual([
      "userMessage", "agentMessage", "custom_tool_call", "custom_tool_call_output", "agentMessage"
    ]);
    expect(detail.turns[0]?.items[0]).toEqual({
      id: "user-1",
      type: "userMessage",
      content: [{ type: "input_text", text: "hello" }]
    });
  });

test("discovers the persisted Claude cwd when resuming a provider-listed session", async () => {
    let observedCwd = "";
    const provider = new ClaudeSdkExecutorProvider(config({ cwd: "" }), {
      queryFactory: ((input) => {
        observedCwd = input.options?.cwd || "";
        return fromMessages([init("session-history", "turn-init"), success("session-history", "turn-resumed")]);
      }) as ClaudeQueryFactory,
      sessionFunctions: {
        getSessionInfo: async () => ({
          sessionId: "session-history",
          summary: "History",
          lastModified: 2_000,
          cwd
        })
      }
    });

    await provider.sendSessionMessage({ prompt: "continue", sessionId: "session-history" });
    expect(observedCwd).toBe(cwd);
  });

test("reports the installed SDK version", async () => {
    const manifest = await Bun.file(new URL("../../../package.json", import.meta.url)).json() as { dependencies: Record<string, string> };
    expect(CLAUDE_AGENT_SDK_VERSION).toBe(manifest.dependencies["@anthropic-ai/claude-agent-sdk"]!);
  });

test("reports missing SDK auth explicitly without treating CLI availability as readiness", () => {
    const provider = new ClaudeSdkExecutorProvider(config({ env: {} }));
    expect(provider.runtimeStatus()).toMatchObject({
      api_key_configured: false,
      executable_ready: true,
      mode: "sdk",
      ready: false,
      auth_configured: false,
      auth_mode: "environment",
      auth_source: "none",
      reason: "Claude SDK environment authentication is not configured",
      version: CLAUDE_AGENT_SDK_VERSION
    });
  });

test("uses a verified local Claude Code login for SDK readiness", () => {
    const provider = new ClaudeSdkExecutorProvider(config({ authMode: "local-cli" }), {
      authInspector: () => ({ auth_method: "oauth_token", checked: true, logged_in: true, provider: "firstParty" })
    });
    expect(provider.runtimeStatus()).toMatchObject({
      auth_configured: true,
      auth_mode: "local-cli",
      auth_source: "local_cli",
      executable_ready: true,
      mode: "sdk",
      ready: true
    });
  });

test("rejects SDK startup when the local Claude Code login is explicitly unavailable", () => {
    const provider = new ClaudeSdkExecutorProvider(config({ authMode: "local-cli" }), {
      authInspector: () => ({ checked: true, logged_in: false, provider: "firstParty" })
    });
    expect(provider.runtimeStatus()).toMatchObject({
      auth_configured: false,
      auth_mode: "local-cli",
      auth_source: "local_cli",
      ready: false,
      reason: "Claude CLI local login is unavailable; run `claude auth login` as the service user"
    });
  });
}
