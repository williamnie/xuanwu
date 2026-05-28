import { describe, expect, test } from "bun:test";
import { CodexAdapter } from "./adapter.ts";
import type { JsonRpcParams } from "./jsonRpc.ts";

describe("Codex adapter RPC methods", () => {
  test("initializes and exposes app-server version capabilities", async () => {
    const rpc = new FakeRpc({
      initialize: {
        protocolVersion: "2026-05-01",
        serverInfo: { name: "codex-app-server", version: "0.42.0" },
        capabilities: { experimentalApi: true, threads: true }
      }
    });
    const result = await new CodexAdapter(rpc).initialize();

    expect(rpc.calls[0]).toEqual({
      method: "initialize",
      params: {
        clientInfo: { name: "codex-issue-runner-bun", version: "0.1.0" },
        capabilities: { experimentalApi: true }
      }
    });
    expect(result).toEqual({
      protocolVersion: "2026-05-01",
      serverInfo: { name: "codex-app-server", version: "0.42.0" },
      capabilities: { experimentalApi: true, threads: true }
    });
  });

  test("normalizes model list responses", async () => {
    const rpc = new FakeRpc({
      "model/list": {
        data: [{
          id: "gpt-5.5",
          name: "GPT-5.5",
          default: true,
          reasoningEfforts: [{ value: "high", label: "High" }]
        }],
        nextCursor: "next"
      }
    });
    const result = await new CodexAdapter(rpc).listModels({ includeHidden: true });

    expect(rpc.calls[0]).toEqual({ method: "model/list", params: { includeHidden: true } });
    expect(result).toEqual({
      data: [{
        id: "gpt-5.5",
        model: "gpt-5.5",
        displayName: "GPT-5.5",
        description: "",
        isDefault: true,
        hidden: false,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }]
      }],
      nextCursor: "next"
    });
  });

  test("normalizes thread list responses", async () => {
    const rpc = new FakeRpc({
      "thread/list": {
        data: [{
          id: "thread-1",
          sessionId: "legacy-session",
          cwd: "/tmp/demo",
          preview: "hello",
          status: { type: "running" }
        }],
        nextCursor: "next"
      }
    });
    const result = await new CodexAdapter(rpc).listThreads({ cursor: "abc", limit: 20 });

    expect(rpc.calls[0]).toEqual({ method: "thread/list", params: { cursor: "abc", limit: 20 } });
    expect(result).toEqual({
      data: [{
        id: "codex:thread-1",
        sessionId: "thread-1",
        provider: "codex",
        provider_session_id: "thread-1",
        cwd: "/tmp/demo",
        preview: "hello",
        status: { type: "running" },
        isRunning: true,
        ephemeral: false
      }],
      nextCursor: "next"
    });
  });

  test("surfaces RPC errors without leaking extra fields", async () => {
    const rpc = new FakeRpc({ "model/list": new Error("codex rpc -32603: boom") });
    await expect(new CodexAdapter(rpc).listModels()).rejects.toThrow("codex rpc -32603: boom");
  });
});

class FakeRpc {
  readonly calls: Array<{ method: string; params: JsonRpcParams }> = [];

  constructor(private readonly responses: Record<string, unknown>) {}

  async request(method: string, params: JsonRpcParams = null): Promise<unknown> {
    this.calls.push({ method, params });
    const response = this.responses[method];
    if (response instanceof Error) throw response;
    return response;
  }
}
