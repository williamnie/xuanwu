import { describe, expect, test } from "bun:test";
import type { Options, Query, SDKMessage, SDKResultMessage, SDKSystemInitMessage } from "@qoder-ai/qoder-agent-sdk";
import { buildConfig } from "../../config/env.ts";
import { createQoderSdkFacade, QoderExecutionError } from "./sdkFacade.ts";

function init(sessionId: string): SDKSystemInitMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    qodercli_version: "1.1.18",
    protocol_version: "1.2.0",
    cwd: "/fixture/project",
    tools: [],
    mcp_servers: [],
    model: "performance",
    permissionMode: "dontAsk",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: `init-${sessionId}`,
    session_id: sessionId
  };
}

function result(sessionId: string, uuid = `result-${sessionId}`): SDKResultMessage {
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
    session_id: sessionId
  };
}

describe("Qoder Q2 real facade with offline fake streams", () => {
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
});

class FakeQuery {
  readonly query: Query;
  interruptCount = 0;
  private done = false;
  private failure: unknown;
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
  return { cwd: "/fixture/project", invocationKey, sessionId };
}
