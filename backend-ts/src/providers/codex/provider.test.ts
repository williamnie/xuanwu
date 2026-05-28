import { describe, expect, test } from "bun:test";
import { CodexExecutorProvider } from "./provider.ts";
import type { CodexInitializeResult, ThreadStartResult, TurnStartResult } from "./adapter.ts";
import type { CodexUserInput, ThreadStartInput, TurnStartOptions } from "./threadLifecycle.ts";

class FakeCodexIssueAdapter {
  readonly calls: Array<{ method: string; params?: unknown }> = [];

  async initialize(): Promise<CodexInitializeResult> {
    this.calls.push({ method: "initialize" });
    return { protocolVersion: "fixture", capabilities: {} };
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
            approvalPolicy: "never",
            sandbox: "workspace-write"
          }
        }
      }
    ]);
  });
});
