import { describe, expect, test } from "bun:test";
import { CodexExecutorProvider, type CodexEventHandler } from "./provider.ts";
import type { CodexInitializeResult, ThreadStartResult, ThreadSummary, TurnStartResult } from "./adapter.ts";
import type { CodexUserInput, ThreadStartInput, TurnStartOptions } from "./threadLifecycle.ts";
import type { ProviderEvent } from "../types.ts";
import { CODEX_EXECUTION_POLICY_CAPABILITIES, codexExecutionPolicyAdapter } from "./executionPolicy.ts";
import { resolveExecutionPolicy } from "../core/policyResolution.ts";
import { EXECUTION_ACCESS_VALUES, EXECUTION_APPROVAL_VALUES } from "../core/policyContracts.ts";

import { FakeCodexIssueAdapter, FakeCodexEventSource, FakeCodexRuntimeControl } from "./providerTestFixtures.ts";

export function registerForwardsLiveCodexAppServerNotifications() {
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
      { method: "thread/read", params: { threadID: "thread-1", includeTurns: true } }
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
}
