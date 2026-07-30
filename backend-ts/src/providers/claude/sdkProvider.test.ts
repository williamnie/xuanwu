import { describe, expect, test } from "bun:test";
import { ClaudeSdkExecutorProvider, type ClaudeQuery, type ClaudeQueryFactory } from "./provider.ts";
import type { ProviderEvent } from "../types.ts";

const cwd = import.meta.dir;

describe("Claude Agent SDK provider", () => {
  test("emits stream events before the query completes and maps provider session/cost/result", async () => {
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const events: ProviderEvent[] = [];
    const provider = sdkProvider(async function* () {
      yield init("session-incremental", "turn-init");
      yield {
        type: "stream_event",
        session_id: "session-incremental",
        uuid: "turn-1",
        event: { delta: { type: "text_delta", text: "first chunk" } }
      };
      await paused;
      yield {
        type: "assistant",
        session_id: "session-incremental",
        uuid: "turn-1",
        message: { content: [{ type: "text", text: "first chunk" }] }
      };
      yield success("session-incremental", "turn-result", {
        total_cost_usd: 0.012345,
        usage: { input_tokens: 10, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 7 }
      });
    });

    const running = provider.run(runInput((event) => events.push(event)));
    await waitFor(() => events.some((event) => event.type === "text_delta"));
    expect(events.map((event) => event.type)).toEqual(["turn_started", "text_delta"]);
    expect(events[1]?.text).toBe("first chunk");

    release();
    const result = await running;
    expect(result.session).toEqual({ provider: "claude", sessionId: "session-incremental", turnId: "turn-result" });
    expect(events.filter((event) => event.type === "text" || event.type === "text_delta")).toEqual([
      expect.objectContaining({ type: "text_delta", text: "first chunk" })
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      runEvent: {
        kind: "completed",
        outcome: "succeeded",
        terminal: true,
        cost: {
          money: { amount_micros: 12345, currency: "USD" },
          usage: {
            cached_input_tokens: 3,
            input_tokens: 15,
            output_tokens: 7,
            total_tokens: 22
          }
        }
      }
    });
    expect(provider.runtimeStatus().active_sessions).toBe(0);
  });

  test("resumes/recover sessions with the real SDK resume ref and cleans aliases", async () => {
    const calls: Array<{ prompt: unknown; resume?: string }> = [];
    let sequence = 0;
    const provider = new ClaudeSdkExecutorProvider(config(), {
      queryFactory: ((input) => {
        calls.push({ prompt: input.prompt, resume: input.options?.resume });
        sequence += 1;
        return fromMessages([
          init(`session-${sequence}`, `turn-init-${sequence}`),
          success(`session-${sequence}`, `turn-${sequence}`)
        ]);
      }) as ClaudeQueryFactory
    });

    const created = await provider.createSession({ cwd, prompt: "create" });
    expect(created).toMatchObject({ provider: "claude", provider_session_id: "session-1", provider_turn_id: "turn-1" });

    const messaged = await provider.sendSessionMessage({ cwd, prompt: "continue", sessionId: "session-1" });
    expect(messaged).toMatchObject({ provider: "claude", provider_session_id: "session-2", turn_id: "turn-2" });

    const recovered = await provider.recover({
      ...runInput(),
      session: { provider: "claude", sessionId: "session-2", turnId: "turn-2" }
    });
    expect(recovered.session?.sessionId).toBe("session-3");
    expect(calls.map((call) => call.resume)).toEqual([undefined, "session-1", "session-2"]);
    expect(provider.runtimeStatus().active_sessions).toBe(0);
  });

  test("interrupts an active query through Query.interrupt plus AbortController and clears listeners", async () => {
    let interrupted = 0;
    let closed = 0;
    let observedSignal: AbortSignal | undefined;
    const events: ProviderEvent[] = [];
    const provider = new ClaudeSdkExecutorProvider(config(), {
      queryFactory: ((input) => {
        observedSignal = input.options?.abortController?.signal;
        return waitingQuery([
          init("session-interrupt", "turn-interrupt")
        ], {
          close: () => { closed += 1; },
          interrupt: async () => { interrupted += 1; }
        });
      }) as ClaudeQueryFactory
    });

    const running = provider.run(runInput((event) => events.push(event)));
    await waitFor(() => provider.runtimeStatus().active_sessions === 1);
    await provider.interrupt({ session: { provider: "claude", sessionId: "session-interrupt", turnId: "turn-interrupt" } });
    await running;

    expect(interrupted).toBe(1);
    expect(observedSignal?.aborted).toBe(true);
    expect(closed).toBeGreaterThanOrEqual(1);
    expect(events.at(-1)).toMatchObject({ type: "error", status: "interrupted", runEvent: { outcome: "interrupted", terminal: true } });
    expect(provider.runtimeStatus().active_sessions).toBe(0);
    expect(provider.interrupt({ session: { provider: "claude", sessionId: "session-interrupt" } })).rejects.toThrow("is not active");
  });

  test("maps provider timeouts to retryable failures and clears the active query", async () => {
    const events: ProviderEvent[] = [];
    const provider = new ClaudeSdkExecutorProvider(config({ timeoutMs: 2 }), {
      queryFactory: (() => waitingQuery([
        init("session-timeout", "turn-timeout")
      ], { close: () => undefined, interrupt: async () => undefined })) as ClaudeQueryFactory
    });

    await expect(provider.run(runInput((event) => events.push(event)))).rejects.toThrow("timed out after 2ms");
    expect(events.at(-1)).toMatchObject({
      type: "error",
      status: "timed_out",
      runEvent: { outcome: "failed", retryable: true, terminal: true }
    });
    expect(provider.runtimeStatus().active_sessions).toBe(0);
  });

  test("preserves unknown SDK events and maps provider result errors", async () => {
    const events: ProviderEvent[] = [];
    const provider = sdkProvider(async function* () {
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
    expect(events[1]).toMatchObject({ type: "unknown", raw: { method: "future_event" }, runEvent: { kind: "unknown" } });
    expect(String(events[1]?.raw?.payload)).not.toContain("sk-ant-secret");
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
      })() as ClaudeQuery) as ClaudeQueryFactory
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
          { type: "assistant", uuid: "assistant-1", parent_tool_use_id: null, session_id: "session-history", message: { role: "assistant", content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } }] } },
          { type: "user", uuid: "tool-result-1", parent_tool_use_id: "tool-1", session_id: "session-history", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "README content" }] } },
          { type: "assistant", uuid: "assistant-2", parent_tool_use_id: null, session_id: "session-history", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }
        ]
      }
    });

    expect(await provider.listSessions({ limit: 20 })).toMatchObject({
      data: [{ id: "claude:session-history", provider: "claude", provider_session_id: "session-history" }],
      nextCursor: ""
    });
    const detail = await provider.readSession("session-history") as { turns: Array<{ items: Array<{ type: string }> }> } & Record<string, unknown>;
    expect(detail).toMatchObject({
      id: "claude:session-history",
      provider: "claude",
      cwd
    });
    expect(detail.turns).toHaveLength(1);
    expect(detail.turns[0]?.items.map((item) => item.type)).toEqual([
      "userMessage", "agentMessage", "custom_tool_call", "custom_tool_call_output", "agentMessage"
    ]);
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
      version: "0.3.152"
    });
  });
});

function sdkProvider(factory: () => AsyncGenerator<unknown>): ClaudeSdkExecutorProvider {
  return new ClaudeSdkExecutorProvider(config(), {
    queryFactory: (() => factory() as ClaudeQuery) as ClaudeQueryFactory
  });
}

function config(overrides: Partial<ReturnType<typeof baseConfig>> = {}) {
  return { ...baseConfig(), ...overrides };
}

function baseConfig() {
  return { command: "claude", cwd, env: {}, mode: "sdk" as const, model: "", timeoutMs: 5_000 };
}

function runInput(onEvent?: (event: ProviderEvent) => void) {
  return { issueId: 1, projectId: "project", cwd, prompt: "run", onEvent };
}

function init(sessionId: string, uuid: string) {
  return { type: "system", subtype: "init", session_id: sessionId, uuid, model: "claude", permissionMode: "dontAsk" };
}

function success(sessionId: string, uuid: string, extra: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    session_id: sessionId,
    uuid,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    ...extra
  };
}

function fromMessages(messages: unknown[]): ClaudeQuery {
  return (async function* () {
    for (const message of messages) yield message;
  })() as ClaudeQuery;
}

function waitingQuery(messages: unknown[], controls: { close(): void; interrupt(): Promise<void> }): ClaudeQuery {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const iterable = (async function* () {
    for (const message of messages) yield message;
    await done;
  })() as ClaudeQuery;
  iterable.interrupt = async () => { await controls.interrupt(); finish(); };
  iterable.close = () => { controls.close(); finish(); };
  return iterable;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(2);
  }
  throw new Error("timed out waiting for condition");
}
