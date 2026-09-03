import { describe, expect, test } from "bun:test";
import type { Options, Query, SDKMessage, SDKResultMessage, SDKSystemInitMessage } from "@qoder-ai/qoder-agent-sdk";
import { buildConfig } from "../../config/env.ts";
import { createQoderSdkFacade, QoderExecutionError } from "./sdkFacade.ts";
import { QODER_EXECUTION_POLICY_CAPABILITIES, qoderExecutionPolicyAdapter } from "./executionPolicy.ts";
import { resolveExecutionPolicy } from "../core/policyResolution.ts";
import type { ExecutionPolicyRequest } from "../core/policyContracts.ts";

function init(sessionId: string, permissionMode: SDKSystemInitMessage["permissionMode"] = "dontAsk"): SDKSystemInitMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    qodercli_version: "1.1.23",
    protocol_version: "1.2.0",
    cwd: "/fixture/project",
    tools: [],
    mcp_servers: [],
    model: "performance",
    permissionMode,
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: `init-${sessionId}`,
    session_id: sessionId
  };
}

function result(
  sessionId: string,
  uuid = `result-${sessionId}`,
  overrides: Partial<SDKResultMessage> = {}
): SDKResultMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 12,
    duration_api_ms: 8,
    is_error: false,
    num_turns: 1,
    result: "ok",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      inference_geo: "",
      input_tokens: 1,
      iterations: [],
      output_tokens: 1,
      server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
      service_tier: "",
      speed: ""
    },
    modelUsage: {},
    permission_denials: [],
    uuid,
    session_id: sessionId,
    ...overrides
  } as SDKResultMessage;
}

describe("Qoder Q2 real facade with offline fake streams", () => {
  test("prompt-free discovery keeps input open until control requests finish", async () => {
    let inputClosed = false;
    let closed: Promise<void> | undefined;
    const facade = createQoderSdkFacade(config(1_000), {
      discoveryQueryFactory: ({ prompt }) => {
        closed = prompt[Symbol.asyncIterator]().next().then((result) => {
          expect(result.done).toBe(true);
          expect(result.value).toBeUndefined();
          inputClosed = true;
        });
        return {
          initializationResult: async () => { await Promise.resolve(); expect(inputClosed).toBe(false); },
          getAvailableModels: async () => {
            expect(inputClosed).toBe(false);
            return [{ value: "performance", displayName: "Performance", description: "fixture", isEnabled: true }];
          },
          interrupt: async () => {}
        } as unknown as Query;
      }
    });
    await expect(facade.listModels()).resolves.toHaveLength(1);
    await closed;
    expect(inputClosed).toBe(true);
  });

  test("prompt-free model discovery uses a short TTL cache and refreshes explicitly", async () => {
    let now = 1_000;
    let discoveries = 0;
    let interrupts = 0;
    const facade = createQoderSdkFacade(config(1_000), {
      modelCacheTtlMs: 50,
      now: () => now,
      discoveryQueryFactory: () => ({
        initializationResult: async () => ({ session_id: "discover" }),
        getAvailableModels: async () => {
          discoveries += 1;
          return [{ value: `performance-${discoveries}`, displayName: "Performance", description: "fixture", isEnabled: true }];
        },
        interrupt: async () => { interrupts += 1; }
      } as unknown as Query)
    });

    await expect(facade.listModels()).resolves.toMatchObject([{ value: "performance-1" }]);
    await expect(facade.listModels()).resolves.toMatchObject([{ value: "performance-1" }]);
    expect(discoveries).toBe(1);
    now += 51;
    await expect(facade.listModels()).resolves.toMatchObject([{ value: "performance-2" }]);
    expect(discoveries).toBe(2);
    expect(interrupts).toBe(2);
  });

  test("model discovery has a bounded deadline and interrupts a stalled control query", async () => {
    let interrupts = 0;
    let signal: AbortSignal | undefined;
    const facade = createQoderSdkFacade(config(1_000), {
      modelDiscoveryTimeoutMs: 8,
      discoveryQueryFactory: ({ options }) => {
        signal = options.abortController?.signal;
        return {
          initializationResult: () => new Promise(() => {}),
          interrupt: async () => { interrupts += 1; },
        } as unknown as Query;
      },
    });

    await expect(facade.listModels()).rejects.toThrow("Qoder model discovery timed out");
    expect(interrupts).toBe(1);
    expect(signal?.aborted).toBe(true);
  });

  test("projects result, model, assistant-request, and session Credits with explicit provenance", async () => {
    const facade = createQoderSdkFacade(config(1_000), {
      queryFactory: ({ options }) => {
        const sessionId = options.sessionId ?? "";
        const stream = new FakeQuery(options);
        stream.setUsageInfo({ session: { total_credits: 7, model_usage: { performance: { credits: 7 } } } });
        stream.push(init(sessionId));
        stream.push({
          type: "assistant",
          message: {
            content: [],
            id: "message-1",
            model: "performance",
            role: "assistant",
            stop_reason: "end_turn",
            stop_sequence: null,
            type: "message",
            usage: { credits: 1.25, input_tokens: 10, output_tokens: 4 }
          },
          parent_tool_use_id: null,
          request_id: "request-1",
          session_id: sessionId,
          uuid: "assistant-1"
        } as unknown as SDKMessage);
        stream.push(result(sessionId, "result-usage", {
          total_credits: 7,
          usage: { ...result(sessionId).usage, credits: 1.25, input_tokens: 10, output_tokens: 4 },
          modelUsage: {
            performance: {
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 2,
              contextWindow: 128_000,
              costUSD: 0,
              credits: 1.25,
              inputTokens: 10,
              maxOutputTokens: 8_192,
              outputTokens: 4,
              webSearchRequests: 0
            }
          }
        }));
        stream.end();
        return stream.query;
      }
    });

    const outcome = await facade.run("go", runOptions("inv-usage", "session-usage"));
    expect(outcome.usage).toMatchObject({
      assistant_requests: [{ credits: 1.25, provenance: "assistant.message.usage", request_id: "request-1" }],
      credits: {
        request: { provenance: "result.usage", value: 1.25 },
        session: { completeness: "partial", provenance: "query.getUsageInfo.session", value: 7 }
      },
      model_usage: { performance: { credits: 1.25, input_tokens: 10, output_tokens: 4 } },
      money: { completeness: "unavailable", reason: "qoder_credits_are_not_currency" },
      result: { input_tokens: 10, output_tokens: 4, provenance: "result.usage", total_tokens: 14 }
    });
  });

  test("active queries are invocation-scoped and interrupt does not cross streams", async () => {
    const streams = new Map<string, FakeQuery>();
    const facade = createQoderSdkFacade(config(1_000), {
      queryFactory: ({ options }) => {
        const sessionId = options.sessionId ?? "";
        const stream = new FakeQuery(options);
        streams.set(sessionId, stream);
        stream.push(init(sessionId));
        return stream.query;
      }
    });
    const first = facade.run("one", runOptions("inv-1", "session-1"));
    const second = facade.run("two", runOptions("inv-2", "session-2"));
    expect(facade.activeCount()).toBe(2);

    await facade.interrupt("inv-1");
    expect(streams.get("session-1")?.interruptCount).toBe(1);
    expect(streams.get("session-2")?.interruptCount).toBe(0);
    streams.get("session-1")?.push(result("session-1"));
    streams.get("session-1")?.end();
    streams.get("session-2")?.push(result("session-2"));
    streams.get("session-2")?.end();

    await expect(first).resolves.toMatchObject({ invocationRef: "inv-1", terminal: "interrupted" });
    await expect(second).resolves.toMatchObject({ invocationRef: "inv-2", terminal: "succeeded" });
    expect(facade.activeCount()).toBe(0);
    await expect(facade.interrupt("inv-1")).rejects.toThrow("not active");
  });

  test("no-result, duplicate-result and stream exception all fail without emitting a result terminal", async () => {
    for (const scenario of ["no-result", "duplicate-result", "exception"] as const) {
      const emitted: SDKMessage[] = [];
      const facade = createQoderSdkFacade(config(1_000), {
        queryFactory: ({ options }) => {
          const sessionId = options.sessionId ?? "";
          const stream = new FakeQuery(options);
          stream.push(init(sessionId));
          if (scenario === "duplicate-result") {
            stream.push(result(sessionId, "result-1"));
            stream.push(result(sessionId, "result-2"));
            stream.end();
          } else if (scenario === "exception") {
            stream.fail(new Error("QODER_PERSONAL_ACCESS_TOKEN=fixture-secret"));
          } else {
            stream.end();
          }
          return stream.query;
        }
      });

      const failure = await facade.run("go", runOptions(`inv-${scenario}`, `session-${scenario}`), (message) => {
        emitted.push(message);
      }).catch((error) => error);
      expect(failure).toBeInstanceOf(QoderExecutionError);
      expect(emitted.filter((message) => message.type === "result")).toHaveLength(0);
      expect(String(failure)).not.toContain("fixture-secret");
      expect(facade.activeCount()).toBe(0);
    }
  });

  test("process errors preserve structured class/code/exit/signal and timeout is retryable", async () => {
    const processFacade = createQoderSdkFacade(config(1_000), {
      queryFactory: ({ options }) => {
        const stream = new FakeQuery(options);
        stream.push(init(options.sessionId ?? ""));
        const error = Object.assign(new Error("qodercli crashed"), {
          code: "QODER_CLI_PROCESS_ERROR",
          exitCode: 17,
          signal: "SIGTERM"
        });
        stream.fail(error);
        return stream.query;
      }
    });
    const processFailure = await processFacade.run("go", runOptions("inv-process", "session-process")).catch((error) => error);
    expect(processFailure).toBeInstanceOf(QoderExecutionError);
    expect((processFailure as QoderExecutionError).details).toMatchObject({
      category: "process",
      code: "QODER_CLI_PROCESS_ERROR",
      errorClass: "Error",
      exitCode: 17,
      retryable: false,
      signal: "SIGTERM"
    });

    const timeoutFacade = createQoderSdkFacade(config(5), {
      queryFactory: ({ options }) => {
        const stream = new FakeQuery(options);
        stream.push(init(options.sessionId ?? ""));
        return stream.query;
      }
    });
    const timeoutFailure = await timeoutFacade.run("go", runOptions("inv-timeout", "session-timeout")).catch((error) => error);
    expect(timeoutFailure).toBeInstanceOf(QoderExecutionError);
    expect((timeoutFailure as QoderExecutionError).details).toMatchObject({ category: "timeout", retryable: true });
    expect(timeoutFacade.activeCount()).toBe(0);
  });

  test("full unattended passes Qoder double bypass and rejects an observed downgrade", async () => {
    let captured: Options | undefined;
    const policy = resolvedPolicy({ access: "unrestricted-host", approval: "unattended" });
    const facade = createQoderSdkFacade(config(1_000), {
      queryFactory: ({ options }) => {
        captured = options;
        const stream = new FakeQuery(options);
        stream.push(init(options.sessionId ?? "", "dontAsk"));
        stream.end();
        return stream.query;
      }
    });

    const failure = await facade.run("go", { ...runOptions("inv-policy", "session-policy"), policy }).catch((error) => error);
    expect(captured).toMatchObject({
      allowDangerouslySkipPermissions: true,
      permissionMode: "bypassPermissions"
    });
    expect(failure).toBeInstanceOf(QoderExecutionError);
    expect((failure as QoderExecutionError).details).toMatchObject({ code: "provider_policy_downgraded", retryable: false });
  });
});

class FakeQuery {
  readonly query: Query;
  interruptCount = 0;
  private done = false;
  private failure: unknown;
  private usageInfo: Awaited<ReturnType<Query["getUsageInfo"]>> = null;
  private readonly queued: Array<IteratorResult<SDKMessage>> = [];
  private readonly pending: Array<{
    reject: (error: unknown) => void;
    resolve: (value: IteratorResult<SDKMessage>) => void;
  }> = [];

  constructor(options: Options) {
    options.abortController?.signal.addEventListener("abort", () => {
      this.fail(new Error(String(options.abortController?.signal.reason ?? "aborted")));
    }, { once: true });
    const iterator = {
      [Symbol.asyncIterator]: () => iterator,
      interrupt: async () => { this.interruptCount += 1; },
      getUsageInfo: async () => this.usageInfo,
      next: () => this.next(),
      return: async () => ({ done: true as const, value: undefined }),
      throw: async (error?: unknown) => { throw error; }
    };
    this.query = iterator as unknown as Query;
  }

  push(message: SDKMessage): void {
    if (this.done) throw new Error("stream already closed");
    const waiter = this.pending.shift();
    if (waiter) waiter.resolve({ done: false, value: message });
    else this.queued.push({ done: false, value: message });
  }

  setUsageInfo(value: Awaited<ReturnType<Query["getUsageInfo"]>>): void {
    this.usageInfo = value;
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    const waiter = this.pending.shift();
    if (waiter) waiter.resolve({ done: true, value: undefined });
    else this.queued.push({ done: true, value: undefined });
  }

  fail(error: unknown): void {
    if (this.done) return;
    this.done = true;
    const waiter = this.pending.shift();
    if (waiter) waiter.reject(error);
    else this.failure = error;
  }

  private next(): Promise<IteratorResult<SDKMessage>> {
    const item = this.queued.shift();
    if (item) return Promise.resolve(item);
    if (this.failure !== undefined) {
      const error = this.failure;
      this.failure = undefined;
      return Promise.reject(error);
    }
    if (this.done) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }
}

function config(timeoutMs: number) {
  return buildConfig({ qoderTimeoutMs: timeoutMs }).providers.qoder!;
}

function runOptions(invocationKey: string, sessionId: string) {
  return { cwd: "/fixture/project", invocationKey, sandbox: "read-only", sessionId };
}

function resolvedPolicy(input: Omit<ExecutionPolicyRequest, "contract">) {
  const request: ExecutionPolicyRequest = { contract: "xw.execution-policy.v1", ...input };
  return resolveExecutionPolicy(request, {
    cwd: "/fixture/project",
    invocationRef: "inv-policy",
    projectId: "project-policy",
    providerId: "qoder",
    providerVersion: "1.0.23",
    source: "local-user",
    transport: "sdk"
  }, QODER_EXECUTION_POLICY_CAPABILITIES, qoderExecutionPolicyAdapter);
}
