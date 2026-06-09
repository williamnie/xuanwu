import { describe, expect, test } from "bun:test";
import { CodexAdapter, CodexThreadLifecycleError } from "./adapter.ts";
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
    const adapter = new CodexAdapter(rpc);
    const result = await adapter.initialize();

    await adapter.initialize();

    expect(rpc.calls).toEqual([{
      method: "initialize",
      params: {
        clientInfo: { name: "codex-issue-runner", version: "0.1.0" },
        capabilities: { experimentalApi: true }
      }
    }]);
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
          reasoningEfforts: [{ value: "high", label: "High" }],
          additionalSpeedTiers: ["fast"],
          serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed" }],
          defaultServiceTier: "priority"
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
        supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }],
        additionalSpeedTiers: ["fast"],
        serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed" }],
        defaultServiceTier: "priority"
      }],
      nextCursor: "next"
    });
  });

  test("starts threads and returns provider session ids for Sessions API", async () => {
    const rpc = new FakeRpc({
      "thread/start": { thread: { id: "thread-new", cwd: "/tmp/demo", status: { state: "running" } } }
    });
    const result = await new CodexAdapter(rpc).startThread({
      cwd: "/tmp/demo",
      model: "codex-default",
      reasoningEffort: "xhigh",
      serviceTier: "priority",
      approvalPolicy: "danger-only",
      sandbox: "workspace-write",
      developerInstructions: "keep changes small",
      threadSource: "subagent"
    });

    expect(rpc.calls[0]).toEqual({
      method: "thread/start",
      params: {
        cwd: "/tmp/demo",
        model: null,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        serviceTier: "priority",
        developerInstructions: "keep changes small",
        ephemeral: false,
        threadSource: "subagent",
        config: { model_reasoning_effort: "xhigh" }
      }
    });
    expect(result).toMatchObject({
      id: "codex:thread-new",
      thread_id: "thread-new",
      sessionId: "thread-new",
      provider: "codex",
      provider_session_id: "thread-new",
      cwd: "/tmp/demo",
      isRunning: true
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

  test("reads, resumes, and names threads through lifecycle RPC calls", async () => {
    const rpc = new FakeRpc({
      "thread/read": { thread: { id: "thread-1", name: "Read title", turns: [{ id: "turn-1" }] } },
      "thread/resume": { thread: { threadId: "thread-1", preview: "resumed", status: "busy" } },
      "thread/name/set": {}
    });
    const adapter = new CodexAdapter(rpc);

    await expect(adapter.readThread("thread-1")).resolves.toMatchObject({
      id: "codex:thread-1",
      provider_session_id: "thread-1",
      name: "Read title",
      turns: [{ id: "turn-1" }]
    });
    await expect(adapter.resumeThread("thread-1")).resolves.toMatchObject({
      id: "codex:thread-1",
      provider_session_id: "thread-1",
      preview: "resumed",
      isRunning: true
    });
    await expect(adapter.setThreadName("thread-1", "Issue title")).resolves.toEqual({
      ok: true,
      provider_session_id: "thread-1"
    });

    expect(rpc.calls.slice(0, 3)).toEqual([
      { method: "thread/read", params: { threadId: "thread-1" } },
      { method: "thread/resume", params: { threadId: "thread-1" } },
      { method: "thread/name/set", params: { threadId: "thread-1", name: "Issue title" } }
    ]);
  });

  test("starts turns with issue prompt input and normalized runtime options", async () => {
    const rpc = new FakeRpc({
      "turn/start": { turn: { id: "turn-1" } }
    });
    const result = await new CodexAdapter(rpc).startTurn("thread-1", [{
      type: "text",
      text: "issue prompt",
      text_elements: []
    }], {
      model: "codex-default",
      reasoningEffort: "xhigh",
      serviceTier: "priority",
      approvalPolicy: "danger-only",
      sandbox: "read-only"
    });

    expect(rpc.calls[0]).toEqual({
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: "issue prompt", text_elements: [] }],
        effort: "xhigh",
        serviceTier: "priority",
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "readOnly" }
      }
    });
    expect(result).toEqual({
      provider: "codex",
      provider_session_id: "thread-1",
      sessionId: "thread-1",
      turn_id: "turn-1"
    });
  });

  test("steers an active session turn through the current Codex RPC contract", async () => {
    const rpc = new FakeRpc({ "turn/steer": { turnId: "turn-active" } });

    const result = await new CodexAdapter(rpc).steerTurn("thread-1", "turn-active", [{
      type: "text",
      text: "adjust",
      text_elements: []
    }]);

    expect(rpc.calls[0]).toEqual({
      method: "turn/steer",
      params: {
        threadId: "thread-1",
        expectedTurnId: "turn-active",
        input: [{ type: "text", text: "adjust", text_elements: [] }]
      }
    });
    expect(result).toEqual({
      provider: "codex",
      provider_session_id: "thread-1",
      sessionId: "thread-1",
      turn_id: "turn-active"
    });
  });

  test("interrupts an active turn through the Codex RPC contract", async () => {
    const rpc = new FakeRpc({ "turn/interrupt": {} });

    await expect(new CodexAdapter(rpc).interruptTurn("thread-1", "turn-1")).resolves.toEqual({
      ok: true,
      provider_session_id: "thread-1",
      turn_id: "turn-1"
    });

    expect(rpc.calls[0]).toEqual({
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" }
    });
  });

  test("resolves approval requests through the Codex RPC contract", async () => {
    const rpc = new FakeRpc({ "approval/resolve": {} });

    await expect(new CodexAdapter(rpc).resolveApproval("approval-1", {
      decision: "approve_session", scope: "session"
    })).resolves.toEqual({ ok: true });

    expect(rpc.calls[0]).toEqual({
      method: "approval/resolve",
      params: { requestId: "approval-1", decision: "approve_session", scope: "session" }
    });
  });

  test("wraps thread lifecycle failures in diagnostic typed errors with redaction", async () => {
    const secret = "fixture-secret-token";
    const rpc = new FakeRpc({ "thread/resume": new Error(`codex rpc -32603: TOKEN=${secret}`) });

    await expect(new CodexAdapter(rpc).resumeThread("thread-1")).rejects.toThrow(CodexThreadLifecycleError);

    try {
      await new CodexAdapter(rpc).resumeThread("thread-1");
      throw new Error("expected lifecycle error");
    } catch (error) {
      expect(error).toBeInstanceOf(CodexThreadLifecycleError);
      const detail = (error as CodexThreadLifecycleError).detail;
      expect(detail).toEqual({
        provider: "codex",
        method: "thread/resume",
        code: "-32603",
        message: "codex rpc -32603: TOKEN=[redacted]"
      });
      expect(String(error)).not.toContain(secret);
    }
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
