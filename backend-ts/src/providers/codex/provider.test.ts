import { describe, expect, test } from "bun:test";
import { CodexExecutorProvider } from "./provider.ts";
import type { CodexInitializeResult, ThreadStartResult, ThreadSummary, TurnStartResult } from "./adapter.ts";
import type { CodexUserInput, ThreadStartInput, TurnStartOptions } from "./threadLifecycle.ts";

class FakeCodexIssueAdapter {
  readonly calls: Array<{ method: string; params?: unknown }> = [];
  readThreadResult: ThreadSummary | null = null;
  resumeThreadResult: ThreadSummary | null = null;

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
    expect(events).toEqual([{
      provider: "codex",
      type: "turn_started",
      status: "inProgress",
      session: { provider: "codex", sessionId: "thread-1", turnId: "turn-1" }
    }]);
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
          developerInstructions: "Keep changes scoped to the runner issue and explicitly update the issue status when done.",
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

  test("reads manual Sessions API detail through resume to hydrate transcript", async () => {
    const adapter = new FakeCodexIssueAdapter();
    adapter.readThreadResult = {
      id: "codex:thread-1",
      provider: "codex",
      provider_session_id: "thread-1",
      sessionId: "thread-1",
      ephemeral: false,
      status: { type: "notLoaded" },
      turns: []
    };
    adapter.resumeThreadResult = {
      id: "codex:thread-1",
      provider: "codex",
      provider_session_id: "thread-1",
      sessionId: "thread-1",
      ephemeral: false,
      status: { type: "loaded" },
      turns: [{ id: "turn-1", items: [{ type: "agentMessage", text: "hydrated" }] }]
    };

    const detail = await new CodexExecutorProvider(adapter).readSession("thread-1");

    expect(detail).toMatchObject({
      id: "codex:thread-1",
      provider_session_id: "thread-1",
      status: { type: "loaded" },
      turns: [{ id: "turn-1" }]
    });
    expect(adapter.calls).toEqual([
      { method: "initialize" },
      { method: "thread/resume", params: { threadID: "thread-1" } }
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

  test("creates manual Sessions API turns and steers running turns", async () => {
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
