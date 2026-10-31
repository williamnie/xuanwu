import { describe, expect, test } from "bun:test";
import { CLAUDE_AGENT_SDK_VERSION, ClaudeSdkExecutorProvider, type ClaudeQuery, type ClaudeQueryFactory } from "./provider.ts";
import type { ProviderEvent } from "../types.ts";

import { cwd, sdkProvider, config, baseConfig, runInput, init, success, fromMessages, waitingQuery, waitFor } from "./sdkProviderTestFixtures.ts";

export function registerMetadataOnlyReadsNeverLoadOr() {
test("metadata-only reads never load or project transcript messages", async () => {
    let reads = 0;
    const provider = new ClaudeSdkExecutorProvider(config(), {
      queryFactory: (() => fromMessages([])) as ClaudeQueryFactory,
      sessionFunctions: {
        getSessionInfo: async () => ({ sessionId: "metadata", summary: "Summary", lastModified: 2000, cwd }),
        getSessionMessages: async () => { reads++; throw new Error("Transcript must not be read"); },
      },
    });
    expect(await provider.readSession("metadata", { includeTurns: false })).toMatchObject({ id: "claude:metadata", turns: [], name: "Summary" });
    expect(reads).toBe(0);
  });

test("emits stream events before the query completes and maps provider session/cost/result", async () => {
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const events: ProviderEvent[] = [];
    const provider = sdkProvider("session-incremental", async function* () {
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
    expect(events.map((event) => event.type)).toEqual(["provider.session_started", "turn_started", "text_delta"]);
    expect(events[2]?.text).toBe("first chunk");

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
    const calls: Array<{ resume?: string; title?: string }> = [];
    const submitted: Array<{ uuid: string; message: { content: string } }> = [];
    const provider = new ClaudeSdkExecutorProvider(config(), {
      queryFactory: ((input) => {
        calls.push({ resume: input.options?.resume, title: input.options?.title });
        const sessionId = input.options?.resume || input.options?.sessionId || "";
        const prompt = input.prompt as AsyncIterable<{ uuid: string; message: { content: string } }>;
        return (async function* () {
          submitted.push((await prompt[Symbol.asyncIterator]().next()).value);
          yield init(sessionId, "turn-init");
          yield success(sessionId, "turn-result");
        })() as ClaudeQuery;
      }) as ClaudeQueryFactory,
      sessionIdFactory: () => "session-1"
    });

    // 提交即返回：turn id 是写给 CLI 的 user message uuid，与会话历史里的 turn id 一致。
    const created = await provider.createSession({ cwd, prompt: "create", title: "Chat title" });
    expect(created).toMatchObject({ provider: "claude", provider_session_id: "session-1", provider_turn_id: submitted[0]?.uuid });
    expect(submitted[0]?.message.content).toBe("create");

    const messaged = await provider.sendSessionMessage({ cwd, prompt: "continue", sessionId: "session-1" });
    await waitFor(() => submitted.length === 2);
    expect(messaged).toMatchObject({ provider: "claude", provider_session_id: "session-1", turn_id: submitted[1]?.uuid });
    await waitFor(() => provider.runtimeStatus().active_sessions === 0);

    const recovered = await provider.recover({
      ...runInput(),
      session: { provider: "claude", sessionId: "session-1", turnId: "turn-result" }
    });
    expect(recovered.session?.sessionId).toBe("session-1");
    expect(calls.map((call) => call.resume)).toEqual([undefined, "session-1", "session-1"]);
    // 续跑沿用会话已保存的标题，只有新会话带 title。
    expect(calls.map((call) => call.title)).toEqual(["Chat title", undefined, undefined]);
    await provider.run(runInput());
    expect(calls.at(-1)?.title).toBe("Issue #1");
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
      }) as ClaudeQueryFactory,
      sessionIdFactory: () => "session-interrupt"
    });

    const running = provider.run(runInput((event) => events.push(event)));
    await waitFor(() => provider.runtimeStatus().active_sessions === 1);
    await provider.interrupt({ session: { provider: "claude", sessionId: "session-interrupt", turnId: "turn-interrupt" } });
    await expect(running).rejects.toThrow("runner interrupt");

    expect(interrupted).toBe(1);
    expect(observedSignal?.aborted).toBe(true);
    expect(closed).toBeGreaterThanOrEqual(1);
    expect(events.at(-1)).toMatchObject({ type: "error", status: "interrupted", runEvent: { outcome: "interrupted", terminal: true } });
    expect(provider.runtimeStatus().active_sessions).toBe(0);
    expect(provider.interrupt({ session: { provider: "claude", sessionId: "session-interrupt" } })).rejects.toThrow("is not active");
  });

test("can interrupt a preallocated Session before the SDK init event arrives", async () => {
    const events: ProviderEvent[] = [];
    const provider = new ClaudeSdkExecutorProvider(config(), {
      queryFactory: (() => waitingQuery([], {
        close: () => undefined,
        interrupt: async () => undefined
      })) as ClaudeQueryFactory,
      sessionIdFactory: () => "session-pre-init"
    });

    const running = provider.run(runInput((event) => events.push(event)));
    await waitFor(() => events.some((event) => event.type === "provider.session_started"));
    await provider.interrupt({
      reason: "issue_cancel",
      session: { provider: "claude", sessionId: "session-pre-init" }
    });

    await expect(running).rejects.toThrow("issue_cancel");
    expect(events).toMatchObject([
      { type: "provider.session_started", session: { sessionId: "session-pre-init" } },
      { type: "error", status: "interrupted", session: { sessionId: "session-pre-init" } }
    ]);
  });

test("maps provider timeouts to retryable failures and clears the active query", async () => {
    const events: ProviderEvent[] = [];
    const provider = new ClaudeSdkExecutorProvider(config({ timeoutMs: 2 }), {
      queryFactory: (() => waitingQuery([
        init("session-timeout", "turn-timeout")
      ], { close: () => undefined, interrupt: async () => undefined })) as ClaudeQueryFactory,
      sessionIdFactory: () => "session-timeout"
    });

    await expect(provider.run(runInput((event) => events.push(event)))).rejects.toThrow("timed out after 2ms");
    expect(events.at(-1)).toMatchObject({
      type: "error",
      status: "timed_out",
      runEvent: { outcome: "failed", retryable: true, terminal: true }
    });
    expect(provider.runtimeStatus().active_sessions).toBe(0);
  });
}
