import { describe, expect, test } from "bun:test";
import { CodexAdapter, CodexThreadLifecycleError } from "./adapter.ts";
import type { JsonRpcParams } from "./jsonRpc.ts";

import { FakeRpc } from "./adapterTestFixtures.ts";

export function registerInitializesAndExposesAppServerVersion() {
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
        clientInfo: { name: "xuanwu", version: "0.1.0" },
        capabilities: { experimentalApi: true }
      }
    }]);
    expect(result).toEqual({
      protocolVersion: "2026-05-01",
      serverInfo: { name: "codex-app-server", version: "0.42.0" },
      capabilities: { experimentalApi: true, threads: true }
    });
  });

test("retries initialize after a transient app-server failure", async () => {
    const rpc = new FakeRpc({ initialize: [new Error("temporary init failure"), { protocolVersion: "fixture" }] });
    const adapter = new CodexAdapter(rpc);

    await expect(adapter.initialize()).rejects.toThrow("temporary init failure");
    await expect(adapter.initialize()).resolves.toMatchObject({ protocolVersion: "fixture" });

    expect(rpc.calls.map((call) => call.method)).toEqual(["initialize", "initialize"]);
  });

test("reinitializes after the RPC process generation changes", async () => {
    const rpc = new FakeRpc({
      initialize: [{ protocolVersion: "before-restart" }, { protocolVersion: "after-restart" }]
    });
    const adapter = new CodexAdapter(rpc);

    await expect(adapter.initialize()).resolves.toMatchObject({ protocolVersion: "before-restart" });

    rpc.bumpGeneration();

    await expect(adapter.initialize()).resolves.toMatchObject({ protocolVersion: "after-restart" });
    expect(rpc.calls.map((call) => call.method)).toEqual(["initialize", "initialize"]);
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

test("omits blank thread list cursors for the current Codex app-server contract", async () => {
    const rpc = new FakeRpc({ "thread/list": { data: [] } });

    await new CodexAdapter(rpc).listThreads({ cursor: "", limit: 20 });

    expect(rpc.calls[0]).toEqual({ method: "thread/list", params: { limit: 20 } });
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
      { method: "thread/read", params: { threadId: "thread-1", includeTurns: true } },
      { method: "thread/resume", params: { threadId: "thread-1" } },
      { method: "thread/name/set", params: { threadId: "thread-1", name: "Issue title" } }
    ]);
  });
}
