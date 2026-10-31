import { describe, expect, test } from "bun:test";
import { CodexExecutorProvider, type CodexEventHandler } from "./provider.ts";
import type { CodexInitializeResult, ThreadStartResult, ThreadSummary, TurnStartResult } from "./adapter.ts";
import type { CodexUserInput, ThreadStartInput, TurnStartOptions } from "./threadLifecycle.ts";
import type { ProviderEvent } from "../types.ts";
import { CODEX_EXECUTION_POLICY_CAPABILITIES, codexExecutionPolicyAdapter } from "./executionPolicy.ts";
import { resolveExecutionPolicy } from "../core/policyResolution.ts";
import { EXECUTION_ACCESS_VALUES, EXECUTION_APPROVAL_VALUES } from "../core/policyContracts.ts";

import { FakeCodexIssueAdapter, FakeCodexEventSource, FakeCodexRuntimeControl } from "./providerTestFixtures.ts";

export function registerCreatesManualSessionsAPITurnsResumes() {
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
}
