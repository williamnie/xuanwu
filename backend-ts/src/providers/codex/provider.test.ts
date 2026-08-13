import { describe, expect, test } from "bun:test";
import { CodexExecutorProvider, type CodexEventHandler } from "./provider.ts";
import type { CodexInitializeResult, ThreadStartResult, ThreadSummary, TurnStartResult } from "./adapter.ts";
import type { CodexUserInput, ThreadStartInput, TurnStartOptions } from "./threadLifecycle.ts";
import type { ProviderEvent } from "../types.ts";

class FakeCodexIssueAdapter {
  readonly calls: Array<{ method: string; params?: unknown }> = [];
  readThreadResult: ThreadSummary | null = null;
  resumeThreadResult: ThreadSummary | null = null;
  startTurnError: Error | null = null;

  async initialize(): Promise<CodexInitializeResult> {
    this.calls.push({ method: "initialize" });
    return { protocolVersion: "fixture", capabilities: {} };
  }

  async readThread(threadID: string): Promise<ThreadSummary> {
    this.calls.push({ method: "thread/read", params: { threadID } });
    return this.readThreadResult ?? this.threadSummary(threadID);
  }

  async resumeThread(threadID: string): Promise<ThreadSummary> {
    this.calls.push({ method: "thread/resume", params: { threadID } });
    return this.resumeThreadResult ?? this.threadSummary(threadID);
  }

  async startThread(input: ThreadStartInput): Promise<ThreadStartResult> {
    this.calls.push({ method: "thread/start", params: input });
    return { id: "codex:thread-1", provider: "codex", provider_session_id: "thread-1", sessionId: "thread-1", thread_id: "thread-1", ephemeral: false };
  }

  async setThreadName(threadID: string, name: string): Promise<{ ok: true; provider_session_id: string }> {
    this.calls.push({ method: "thread/name/set", params: { threadID, name } });
    return { ok: true, provider_session_id: threadID };
  }

  async startTurn(threadID: string, input: CodexUserInput[], options: TurnStartOptions = {}): Promise<TurnStartResult> {
    this.calls.push({ method: "turn/start", params: { threadID, input, options } });
    if (this.startTurnError) throw this.startTurnError;
    return { provider: "codex", provider_session_id: threadID, sessionId: threadID, turn_id: "turn-1" };
  }

  async steerTurn(threadID: string, turnID: string, input: CodexUserInput[]): Promise<TurnStartResult> {
    this.calls.push({ method: "turn/steer", params: { threadID, turnID, input } });
    return { provider: "codex", provider_session_id: threadID, sessionId: threadID, turn_id: turnID };
  }

  async interruptTurn(threadID: string, turnID: string) {
    this.calls.push({ method: "turn/interrupt", params: { threadID, turnID } });
    return { ok: true as const, provider_session_id: threadID, turn_id: turnID };
  }

  private threadSummary(threadID: string): ThreadSummary {
    return { id: `codex:${threadID}`, provider: "codex", provider_session_id: threadID, sessionId: threadID, ephemeral: false };
  }
}

class FakeCodexEventSource {
  readonly handlers = new Set<CodexEventHandler>();

  emit(event: ProviderEvent): void {
    for (const handler of this.handlers) handler(event);
  }

  subscribe(handler: CodexEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

class FakeCodexRuntimeControl {
  acquired: string[] = [];
  released = 0;

  acquire(owner: string) {
    this.acquired.push(owner);
    return {
      bind: () => {},
      release: () => { this.released += 1; }
    };
  }

  releaseSession(): void {}
  runtimeSnapshot() { return { idle_ttl_ms: 15_000, owners: [] }; }
  async stop(): Promise<void> {}
}

describe("Codex executor provider", () => {
  test("starts a Codex thread and one issue turn", async () => {
    const adapter = new FakeCodexIssueAdapter();
    const events: unknown[] = [];
    const result = await new CodexExecutorProvider(adapter).run({
      issueId: 160,
      projectId: "demo",
      cwd: "/tmp/demo",
      prompt: "issue body",
      model: "codex-default",
      reasoningEffort: "high",
      serviceTier: "priority",
      approvalPolicy: "never",
      sandbox: "workspace-write",
      onEvent: (event) => events.push(event)
    });

    expect(result).toEqual({
      runId: "codex:thread-1:turn-1",
      session: { provider: "codex", sessionId: "thread-1", turnId: "turn-1" }
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      provider: "codex",
      type: "provider.session_started",
      status: "running",
      session: { provider: "codex", sessionId: "thread-1" }
    });
    expect(events[1]).toMatchObject({
      provider: "codex",
      type: "turn_started",
      status: "inProgress",
      session: { provider: "codex", sessionId: "thread-1", turnId: "turn-1" },
      runEvent: {
        contract: "xw.run-event.v1",
        kind: "started",
        metadata: {
          model: "codex-default",
          protocol_version: "fixture",
          service_tier: "priority"
        },
        outcome: "running",
        terminal: false
      }
    });
    expect(adapter.calls).toEqual([
      { method: "initialize" },
      {
        method: "thread/start",
        params: {
          cwd: "/tmp/demo",
          model: "codex-default",
          reasoningEffort: "high",
          serviceTier: "priority",
          approvalPolicy: "never",
          sandbox: "workspace-write",
          developerInstructions: "Keep changes scoped to the runner issue. You are executing an Issue already claimed by Xuanwu. Never use Xuanwu CLI or API lifecycle commands to create, deduplicate, enqueue, retry, cancel, delete, or change the status of the current Issue, and never stop its current Run. Report the result with the RUNNER_OUTCOME marker required by the execution context; the Host reconciles the Run and PI alone decides semantic Issue status.",
          threadSource: "subagent"
        }
      },
      { method: "thread/name/set", params: { threadID: "thread-1", name: "Issue #160" } },
      {
        method: "turn/start",
        params: {
          threadID: "thread-1",
          input: [{ type: "text", text: "issue body", text_elements: [] }],
          options: {
            model: "codex-default",
            reasoningEffort: "high",
            serviceTier: "priority",
            approvalPolicy: "never",
            sandbox: "workspace-write"
          }
        }
      }
    ]);
  });

  test("forwards live Codex app-server notifications for the issue thread", async () => {
    const adapter = new FakeCodexIssueAdapter();
    const source = new FakeCodexEventSource();
    const runtime = new FakeCodexRuntimeControl();
    const events: unknown[] = [];

    await new CodexExecutorProvider(adapter, "instructions", source, runtime).run({
      issueId: 160,
      projectId: "demo",
      cwd: "/tmp/demo",
      prompt: "issue body",
      onEvent: (event) => {
        events.push(event);
        if (event.type === "turn_started") {
          source.emit({
            provider: "codex",
            type: "text",
            text: "live output",
            session: { provider: "codex", sessionId: "thread-1", turnId: "turn-1" },
            raw: { method: "item/agentMessage/delta" }
          });
          source.emit({
            provider: "codex",
            type: "text",
            text: "other thread",
            session: { provider: "codex", sessionId: "thread-2", turnId: "turn-x" }
          });
          source.emit({
            provider: "codex",
            type: "done",
            status: "completed",
            session: { provider: "codex", sessionId: "thread-1", turnId: "turn-1" },
            raw: { method: "turn/completed" }
          });
        }
      }
    });

    await Bun.sleep(1);
    expect(events).toMatchObject([
      { type: "provider.session_started" },
      { type: "turn_started" },
      { type: "text", text: "live output" },
      { type: "done", status: "completed" }
    ]);
    expect(source.handlers.size).toBe(0);
    expect(runtime.acquired).toEqual(["project:demo:issue:160:run"]);
    expect(runtime.released).toBe(1);
    expect(adapter.calls.filter((call) => call.method === "thread/read")).toHaveLength(0);
  });

  test("keeps the durable Codex thread observable when turn start fails", async () => {
    const adapter = new FakeCodexIssueAdapter();
    adapter.startTurnError = new Error("turn start failed");
    const events: ProviderEvent[] = [];

    await expect(new CodexExecutorProvider(adapter).run({
      issueId: 162,
      projectId: "demo",
      cwd: "/tmp/demo",
      prompt: "issue body",
      onEvent: (event) => events.push(event)
    })).rejects.toThrow("turn start failed");

    expect(events).toMatchObject([{
      type: "provider.session_started",
      session: { provider: "codex", sessionId: "thread-1" }
    }]);
  });

  test("reads manual Sessions API detail passively with turns included", async () => {
    const adapter = new FakeCodexIssueAdapter();
    adapter.readThreadResult = {
      id: "codex:thread-1",
      provider: "codex",
      provider_session_id: "thread-1",
      sessionId: "thread-1",
      ephemeral: false,
      status: { type: "notLoaded" },
      turns: [{ id: "turn-1", items: [{ type: "agentMessage", text: "hydrated" }] }]
    };

    const detail = await new CodexExecutorProvider(adapter).readSession("thread-1");

    expect(detail).toMatchObject({
      id: "codex:thread-1",
      provider_session_id: "thread-1",
      status: { type: "notLoaded" },
      turns: [{ id: "turn-1" }]
    });
    expect(adapter.calls).toEqual([
      { method: "initialize" },
      { method: "thread/read", params: { threadID: "thread-1" } }
    ]);
  });

  test("recovers an existing Codex thread with a continuation turn", async () => {
    const adapter = new FakeCodexIssueAdapter();
    const result = await new CodexExecutorProvider(adapter).recover({
      issueId: 161,
      projectId: "demo",
      cwd: "/tmp/demo",
      prompt: "recover prompt",
      session: { provider: "codex", sessionId: "thread-1", turnId: "turn-old" }
    });

    expect(result).toEqual({
      runId: "codex:thread-1:turn-1",
      session: { provider: "codex", sessionId: "thread-1", turnId: "turn-1" }
    });
    expect(adapter.calls).toEqual([
      { method: "initialize" },
      { method: "thread/resume", params: { threadID: "thread-1" } },
      {
        method: "turn/start",
        params: {
          threadID: "thread-1",
          input: [{ type: "text", text: "recover prompt", text_elements: [] }],
          options: {}
        }
      }
    ]);
  });

  test("interrupts a Codex turn through the adapter", async () => {
    const adapter = new FakeCodexIssueAdapter();

    await new CodexExecutorProvider(adapter).interrupt({
      session: { provider: "codex", sessionId: "thread-1", turnId: "turn-1" },
      reason: "issue_cancel"
    });

    expect(adapter.calls).toEqual([
      { method: "initialize" },
      { method: "turn/interrupt", params: { threadID: "thread-1", turnID: "turn-1" } }
    ]);
  });

  test("creates manual Sessions API turns, resumes historical threads, and steers running turns", async () => {
    const adapter = new FakeCodexIssueAdapter();
    const provider = new CodexExecutorProvider(adapter, "manual instructions");

    const created = await provider.createSession({
      cwd: "/tmp/demo",
      prompt: "hello",
      reasoningEffort: "high",
      serviceTier: "priority"
    });
    const message = await provider.sendSessionMessage({ sessionId: "thread-1", prompt: "follow", serviceTier: "priority" });
    const steer = await provider.sendSessionMessage({
      sessionId: "thread-1",
      prompt: "adjust",
      mode: "steer",
      turnId: "turn-1"
    });

    expect(created).toEqual({
      id: "codex:thread-1",
      provider: "codex",
      provider_session_id: "thread-1",
      provider_turn_id: "turn-1",
      thread_id: "thread-1",
      turn_id: "turn-1"
    });
    expect(message).toEqual({ provider: "codex", provider_session_id: "thread-1", sessionId: "thread-1", turn_id: "turn-1" });
    expect(steer).toEqual({ provider: "codex", provider_session_id: "thread-1", sessionId: "thread-1", turn_id: "turn-1" });
    expect(adapter.calls).toEqual([
      { method: "initialize" },
      {
        method: "thread/start",
        params: {
          cwd: "/tmp/demo",
          reasoningEffort: "high",
          serviceTier: "priority",
          developerInstructions: "manual instructions",
          threadSource: "user"
        }
      },
      {
        method: "turn/start",
        params: {
          threadID: "thread-1",
          input: [{ type: "text", text: "hello", text_elements: [] }],
          options: { reasoningEffort: "high", serviceTier: "priority" }
        }
      },
      { method: "initialize" },
      { method: "thread/resume", params: { threadID: "thread-1" } },
      {
        method: "turn/start",
        params: {
          threadID: "thread-1",
          input: [{ type: "text", text: "follow", text_elements: [] }],
          options: { serviceTier: "priority" }
        }
      },
      { method: "initialize" },
      {
        method: "turn/steer",
        params: {
          threadID: "thread-1",
          turnID: "turn-1",
          input: [{ type: "text", text: "adjust", text_elements: [] }]
        }
      }
    ]);
  });
});
