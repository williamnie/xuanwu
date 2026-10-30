import { describe, expect, test } from "bun:test";
import type { Options, Query, SDKMessage, SDKResultMessage, SDKSystemInitMessage } from "@qoder-ai/qoder-agent-sdk";
import { buildConfig } from "../../config/env.ts";
import { createQoderSdkFacade, QoderExecutionError } from "./sdkFacade.ts";
import { QODER_EXECUTION_POLICY_CAPABILITIES, qoderExecutionPolicyAdapter } from "./executionPolicy.ts";
import { resolveExecutionPolicy } from "../core/policyResolution.ts";
import type { ExecutionPolicyRequest } from "../core/policyContracts.ts";

export function init(sessionId: string, permissionMode: SDKSystemInitMessage["permissionMode"] = "dontAsk"): SDKSystemInitMessage {
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

export function result(
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

export class FakeQuery {
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

export function config(timeoutMs: number) {
  return buildConfig({ qoderTimeoutMs: timeoutMs }).providers.qoder!;
}

export function runOptions(invocationKey: string, sessionId: string) {
  return { cwd: "/fixture/project", invocationKey, sandbox: "read-only", sessionId };
}

export function resolvedPolicy(input: Omit<ExecutionPolicyRequest, "contract">) {
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
