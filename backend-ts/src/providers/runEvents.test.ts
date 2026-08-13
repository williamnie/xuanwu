import { describe, expect, test } from "bun:test";
import { ClaudeExecutorProvider, type ClaudeProcessFactory } from "./claude/provider.ts";
import { normalizeCodexEvent } from "./codex/events.ts";
import { validateNormalizedRunEvent } from "./runEvents.ts";
import type { NormalizedRunEvent, ProviderEvent } from "./types.ts";

describe("provider Run event fixture conformance", () => {
  test("normalizes Codex lifecycle, usage, approval, unknown, and completion fixtures", () => {
    const fixtures = [
      { method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } },
      { method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", delta: "working" } },
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            last: { cachedInputTokens: 3, inputTokens: 10, outputTokens: 5, reasoningOutputTokens: 2, totalTokens: 15 },
            total: { cachedInputTokens: 7, inputTokens: 30, outputTokens: 12, reasoningOutputTokens: 4, totalTokens: 42 },
            modelContextWindow: 200000
          }
        }
      },
      { method: "approval/requested", params: { threadId: "thread-1", turnId: "turn-1" } },
      { method: "approval/resolved", params: { threadId: "thread-1", turnId: "turn-1" } },
      { method: "future/event", params: { threadId: "thread-1", turnId: "turn-1", opaque: true } },
      { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } }
    ];
    const events = fixtures.map(normalizeCodexEvent);
    const runEvents = requiredRunEvents(events);

    expect(runEvents.map((event) => event.kind)).toEqual([
      "started", "progress", "progress", "approval_requested", "approval_resolved", "unknown", "completed"
    ]);
    expect(runEvents.flatMap(validateNormalizedRunEvent)).toEqual([]);
    expect(runEvents[2]).toMatchObject({
      cost: {
        money: { amount_micros: null, basis: "unavailable", currency: "" },
        usage: {
          cached_input_tokens: 7,
          completeness: "complete",
          input_tokens: 30,
          output_tokens: 12,
          reasoning_output_tokens: 4,
          total_tokens: 42
        }
      },
      metadata: { model_context_window: 200000, usage_scope: "provider_session_total" }
    });
    expect(runEvents.at(-1)).toMatchObject({ kind: "completed", outcome: "succeeded", terminal: true });
  });

  test("normalizes Claude fixtures to the same terminal outcome and provider-reported cost", async () => {
    const stdout = jsonl([
      { type: "system", subtype: "init", session_id: "claude-session" },
      { type: "assistant", message: { content: [{ type: "text", text: "working" }] } },
      { type: "future_event", session_id: "claude-session", opaque: true },
      {
        type: "result",
        session_id: "claude-session",
        uuid: "claude-turn",
        is_error: false,
        terminal_reason: "end_turn",
        duration_ms: 1200,
        duration_api_ms: 900,
        num_turns: 2,
        total_cost_usd: 0.012345,
        usage: { input_tokens: 20, cache_read_input_tokens: 5, output_tokens: 8 },
        modelUsage: { "claude-sonnet-4": { costUSD: 0.012345 } }
      }
    ]);
    const events: ProviderEvent[] = [];
    const provider = new ClaudeExecutorProvider(
      { command: "claude", cwd: "", env: {}, model: "sonnet", timeoutMs: 1000 },
      { processFactory: completedProcess(stdout), sessionIdFactory: () => "claude-session" }
    );

    await provider.run({
      cwd: "/tmp",
      issueId: 658,
      onEvent: (event) => events.push(event),
      projectId: "demo",
      prompt: "fixture"
    });

    const runEvents = requiredRunEvents(events);
    expect(runEvents.map((event) => event.kind)).toEqual(["started", "progress", "progress", "unknown", "completed"]);
    expect(runEvents.flatMap(validateNormalizedRunEvent)).toEqual([]);
    expect(runEvents.at(-1)).toMatchObject({
      cost: {
        money: { amount_micros: 12345, basis: "provider_reported", currency: "USD" },
        usage: {
          cached_input_tokens: 5,
          completeness: "partial",
          input_tokens: 20,
          output_tokens: 8,
          reasoning_output_tokens: null,
          total_tokens: 28
        }
      },
      kind: "completed",
      metadata: { models: "claude-sonnet-4", usage_scope: "attempt" },
      outcome: "succeeded",
      terminal: true
    });
  });
});

function requiredRunEvents(events: ProviderEvent[]): NormalizedRunEvent[] {
  return events.map((event) => {
    if (!event.runEvent) throw new Error(`missing normalized Run event for ${event.raw?.method ?? event.type}`);
    return event.runEvent;
  });
}

function completedProcess(stdout: string): ClaudeProcessFactory {
  return () => ({
    exited: Promise.resolve(0),
    kill: () => undefined,
    stderr: streamFrom(""),
    stdout: streamFrom(stdout)
  });
}

function streamFrom(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (text !== "") controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    }
  });
}

function jsonl(records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}
