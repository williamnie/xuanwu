import { describe, expect, test } from "bun:test";
import type { Options, Query, SDKMessage, SDKResultMessage, SDKSystemInitMessage } from "@qoder-ai/qoder-agent-sdk";
import { buildConfig } from "../../config/env.ts";
import { createQoderSdkFacade, QoderExecutionError } from "./sdkFacade.ts";
import { QODER_EXECUTION_POLICY_CAPABILITIES, qoderExecutionPolicyAdapter } from "./executionPolicy.ts";
import { resolveExecutionPolicy } from "../core/policyResolution.ts";
import type { ExecutionPolicyRequest } from "../core/policyContracts.ts";

import { init, result, FakeQuery, config, runOptions, resolvedPolicy } from "./sdkFacadeTestFixtures.ts";

export function registerPromptFreeDiscoveryKeepsInputOpen() {
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
}
