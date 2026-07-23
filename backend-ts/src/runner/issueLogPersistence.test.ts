import { describe, expect, test } from "bun:test";
import type { ProviderEvent } from "../providers/types.ts";
import {
  ISSUE_LOG_BUDGET_MARKER_METHOD,
  ISSUE_LOG_DELTA_ROWS_PER_METHOD,
  ISSUE_LOG_LIFECYCLE_ROWS_PER_TYPE,
  ISSUE_LOG_PROTECTED_ROWS_PER_METHOD,
  ISSUE_LOG_SAMPLE_ROWS_PER_METHOD,
  createIssueLogPersistence
} from "./issueLogPersistence.ts";

const session = { provider: "codex" as const, sessionId: "thread-long", turnId: "turn-long" };

describe("issue.log persistence reduction", () => {
  test("normal mode drops streaming protocol noise but keeps decisive events", () => {
    const persisted: ProviderEvent[] = [];
    const persistence = createIssueLogPersistence(
      (event) => persisted.push(event),
      { mode: "normal" }
    );
    persistence.push({
      provider: "codex",
      type: "text",
      session,
      text: "streaming",
      raw: { method: "item/agentMessage/delta", payload: "streaming" }
    });
    persistence.push({
      provider: "codex",
      type: "raw",
      session,
      raw: { method: "turn/plan/updated", payload: "plan" }
    });
    persistence.push({
      provider: "codex",
      type: "raw",
      session,
      raw: {
        method: "item/completed",
        payload: JSON.stringify({ item: { id: "message-final", type: "agentMessage", text: "final" } })
      }
    });
    persistence.push({
      provider: "codex",
      type: "done",
      status: "completed",
      session,
      raw: { method: "turn/completed", payload: "completed" }
    });
    persistence.flush();

    expect(persisted.map((event) => event.raw?.method)).toEqual(["item/completed", "turn/completed"]);
    expect(persisted[0]).toMatchObject({ text: "final" });
  });

  test("normal mode stores verification results but skips ordinary successful command output", () => {
    const persisted: ProviderEvent[] = [];
    const persistence = createIssueLogPersistence(
      (event) => persisted.push(event),
      { mode: "normal" }
    );
    const commandCompleted = (id: string, command: string) => ({
      provider: "codex" as const,
      type: "tool",
      session,
      command,
      status: "completed",
      raw: {
        method: "item/completed",
        payload: JSON.stringify({
          item: { command, exitCode: 0, id, status: "completed", type: "commandExecution" }
        })
      }
    });
    persistence.push(commandCompleted("ordinary", "git status"));
    persistence.push(commandCompleted("verification", "bun test src/example.test.ts"));
    persistence.flush();

    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ command: "bun test src/example.test.ts" });
  });

  test("chunks Codex deltas, samples telemetry, and keeps terminal errors", () => {
    const input: ProviderEvent[] = [];
    const persisted: ProviderEvent[] = [];
    const persistence = createIssueLogPersistence((event) => persisted.push(event));

    for (let index = 0; index < 130; index += 1) {
      input.push({
        provider: "codex",
        type: "text",
        session,
        text: String(index % 10),
        raw: { method: "item/agentMessage/delta", payload: JSON.stringify({ delta: String(index % 10) }) }
      });
    }
    for (let index = 1; index <= 41; index += 1) {
      input.push({
        provider: "codex",
        type: "raw",
        session,
        raw: { method: "thread/tokenUsage/updated", payload: JSON.stringify({ total_tokens: index }) }
      });
    }
    for (let index = 0; index < 8; index += 1) {
      input.push({
        provider: "codex",
        type: "raw",
        session,
        payload: "turn/diff/updated repeated",
        raw: { method: "turn/diff/updated", payload: "same cumulative diff" }
      });
    }
    input.push({
      provider: "codex",
      type: "error",
      session,
      status: "failed",
      error: "stream disconnected",
      raw: { method: "error", payload: JSON.stringify({ error: "stream disconnected" }) }
    });

    input.forEach((event) => persistence.push(event));
    persistence.flush();

    expect(persisted).toHaveLength(11);
    expect(persisted.filter((event) => event.raw?.method === "item/agentMessage/delta")).toHaveLength(3);
    expect(persisted
      .filter((event) => event.raw?.method === "item/agentMessage/delta")
      .map((event) => event.text)
      .join("")).toBe(input.slice(0, 130).map((event) => event.text).join(""));
    expect(persisted.filter((event) => event.raw?.method === "thread/tokenUsage/updated")).toHaveLength(4);
    expect(persisted.filter((event) => event.raw?.method === "thread/tokenUsage/updated").at(-1)?.raw?.payload)
      .toBe(JSON.stringify({ total_tokens: 41 }));
    expect(persisted.filter((event) => event.raw?.method === "turn/diff/updated")).toHaveLength(1);
    expect(persisted.at(-1)).toMatchObject({ type: "error", error: "stream disconnected", status: "failed" });
    const markers = persisted.filter((event) => event.raw?.method === ISSUE_LOG_BUDGET_MARKER_METHOD);
    expect(markers).toHaveLength(2);
    expect(markers.map((event) => event.payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "sample", omitted_events: 37, source_method: "thread/tokenUsage/updated" }),
      expect.objectContaining({ category: "sample", omitted_events: 7, source_method: "turn/diff/updated" })
    ]));

    const baselineBytes = Buffer.byteLength(JSON.stringify(input));
    const persistedBytes = Buffer.byteLength(JSON.stringify(persisted));
    expect(persistedBytes).toBeLessThan(baselineBytes * 0.2);
  });

  test("does not merge Claude record-level output or decisive lifecycle events", () => {
    const persisted: ProviderEvent[] = [];
    const persistence = createIssueLogPersistence((event) => persisted.push(event));
    const claudeSession = { provider: "claude" as const, sessionId: "sess-1", turnId: "turn-1" };
    const events: ProviderEvent[] = [
      { provider: "claude", type: "text", session: claudeSession, text: "first", raw: { method: "assistant", payload: "first-record" } },
      { provider: "claude", type: "text", session: claudeSession, text: "second", raw: { method: "assistant", payload: "second-record" } },
      { provider: "claude", type: "done", session: claudeSession, status: "end_turn", raw: { method: "result", payload: "result-record" } }
    ];

    events.forEach((event) => persistence.push(event));
    persistence.flush();

    expect(persisted).toEqual(events);
  });

  test("bounds arbitrarily long deltas and cumulative samples while preserving terminal snapshots", () => {
    const input: ProviderEvent[] = [];
    const persisted: ProviderEvent[] = [];
    const persistence = createIssueLogPersistence((event) => persisted.push(event));
    for (let index = 0; index < 10_000; index += 1) {
      input.push({
        provider: "codex",
        type: "tool",
        session,
        text: `output-${index}\n`,
        command: "generate-large-output",
        raw: { method: "item/commandExecution/outputDelta", payload: JSON.stringify({ delta: `output-${index}\n` }) }
      });
      input.push({
        provider: "codex",
        type: "raw",
        session,
        payload: `diff-${index}`,
        raw: { method: "turn/diff/updated", payload: JSON.stringify({ diff: `diff-${index}` }) }
      });
    }
    input.push({
      provider: "codex",
      type: "tool",
      session,
      command: "generate-large-output",
      status: "completed",
      text: "",
      raw: {
        method: "item/completed",
        payload: JSON.stringify({ item: { type: "commandExecution", id: "cmd-final", command: "generate-large-output", status: "completed", aggregatedOutput: "final-output" } })
      }
    });
    input.push({ provider: "codex", type: "done", session, status: "completed", raw: { method: "turn/completed", payload: "terminal" } });

    input.forEach((event) => persistence.push(event));
    persistence.flush();

    expect(persisted.filter((event) => event.raw?.method === "item/commandExecution/outputDelta").length)
      .toBeLessThanOrEqual(ISSUE_LOG_DELTA_ROWS_PER_METHOD);
    expect(persisted.filter((event) => event.raw?.method === "turn/diff/updated").length)
      .toBeLessThanOrEqual(ISSUE_LOG_SAMPLE_ROWS_PER_METHOD);
    expect(persisted.filter((event) => event.raw?.method === ISSUE_LOG_BUDGET_MARKER_METHOD)).toHaveLength(2);
    expect(persisted.find((event) => event.raw?.method === "item/completed")?.raw?.payload).toContain("final-output");
    expect(persisted.at(-1)).toMatchObject({ type: "done", status: "completed" });
    expect(persisted.length).toBeLessThan(input.length * 0.01);
    expect(Buffer.byteLength(JSON.stringify(persisted))).toBeLessThan(Buffer.byteLength(JSON.stringify(input)) * 0.1);
  });

  test("keeps failures and cancellations and resets budgets for a recovered stream", () => {
    const first: ProviderEvent[] = [];
    const failed = createIssueLogPersistence((event) => first.push(event));
    failed.push({ provider: "codex", type: "error", session, status: "failed", error: "disconnect", raw: { method: "error", payload: "disconnect" } });
    failed.flush();

    const recovered: ProviderEvent[] = [];
    const resumed = createIssueLogPersistence((event) => recovered.push(event));
    resumed.push({ provider: "codex", type: "text", session, text: "resumed", raw: { method: "item/agentMessage/delta", payload: "resumed" } });
    resumed.push({ provider: "codex", type: "done", session, status: "cancelled", raw: { method: "turn/completed", payload: "cancelled" } });
    resumed.flush();

    expect(first).toEqual([expect.objectContaining({ type: "error", error: "disconnect", status: "failed" })]);
    expect(recovered.map((event) => event.raw?.method)).toEqual(["item/agentMessage/delta", "turn/completed"]);
    expect(recovered.at(-1)).toMatchObject({ status: "cancelled", type: "done" });
  });

  test("stores only necessary snapshots for duplicated lifecycle envelopes and preserves final messages", () => {
    const persisted: ProviderEvent[] = [];
    const persistence = createIssueLogPersistence((event) => persisted.push(event));
    const envelope = (method: "item/started" | "item/completed", type: string, text = "") => ({
      provider: "codex" as const,
      type: "raw",
      session,
      raw: { method, payload: JSON.stringify({ item: { id: `${method}-${type}`, type, text, phase: "final_answer", repeated: "x".repeat(20_000) } }) }
    });
    persistence.push(envelope("item/started", "reasoning"));
    persistence.push(envelope("item/completed", "reasoning"));
    persistence.push(envelope("item/completed", "agentMessage", "decisive final message"));
    persistence.flush();

    expect(persisted.map((event) => event.raw?.payload)).toEqual([undefined, undefined, undefined]);
    expect(persisted.map((event) => event.payload)).toEqual([
      expect.objectContaining({ item_type: "reasoning", raw_payload_omitted: true }),
      expect.objectContaining({ item_type: "reasoning", raw_payload_omitted: true }),
      expect.objectContaining({ item_type: "agentMessage", raw_payload_omitted: true })
    ]);
    expect(persisted.at(-1)?.text).toBe("decisive final message");
    expect(Buffer.byteLength(JSON.stringify(persisted))).toBeLessThan(2_000);
  });

  test("does not duplicate a complete final agent message when all deltas fit the budget", () => {
    const persisted: ProviderEvent[] = [];
    const persistence = createIssueLogPersistence((event) => persisted.push(event));
    persistence.push({ provider: "codex", type: "text", session, text: "complete answer", raw: { method: "item/agentMessage/delta", payload: "complete answer" } });
    persistence.push({
      provider: "codex",
      type: "raw",
      session,
      raw: { method: "item/completed", payload: JSON.stringify({ item: { id: "message-final", type: "agentMessage", text: "complete answer" } }) }
    });
    persistence.flush();

    expect(persisted.map((event) => event.text).filter(Boolean)).toEqual(["complete answer"]);
    expect(persisted.at(-1)).toMatchObject({
      payload: expect.objectContaining({ item_type: "agentMessage", raw_payload_omitted: true }),
      raw: { method: "item/completed" }
    });
  });

  test("bounds non-decisive lifecycle rows and fails closed on protected row overflow", () => {
    const lifecycle: ProviderEvent[] = [];
    const persistence = createIssueLogPersistence((event) => lifecycle.push(event));
    for (let index = 0; index < ISSUE_LOG_LIFECYCLE_ROWS_PER_TYPE + 20; index += 1) {
      persistence.push({
        provider: "codex",
        type: "raw",
        session,
        raw: { method: "item/started", payload: JSON.stringify({ item: { id: `reasoning-${index}`, type: "reasoning" } }) }
      });
    }
    persistence.push({ provider: "codex", type: "done", session, status: "completed", raw: { method: "turn/completed", payload: "completed" } });

    expect(lifecycle.filter((event) => event.raw?.method === "item/started")).toHaveLength(ISSUE_LOG_LIFECYCLE_ROWS_PER_TYPE);
    expect(lifecycle.find((event) => event.raw?.method === ISSUE_LOG_BUDGET_MARKER_METHOD)?.payload).toMatchObject({
      category: "lifecycle",
      omitted_events: 20
    });

    const protectedEvents: ProviderEvent[] = [];
    const protectedPersistence = createIssueLogPersistence((event) => protectedEvents.push(event));
    for (let index = 0; index < ISSUE_LOG_PROTECTED_ROWS_PER_METHOD; index += 1) {
      protectedPersistence.push({ provider: "codex", type: "raw", session, raw: { method: "approval/requested", payload: String(index) } });
    }
    expect(() => protectedPersistence.push({
      provider: "codex", type: "raw", session, raw: { method: "approval/requested", payload: "overflow" }
    })).toThrow("protected event budget exceeded");
    expect(protectedEvents.at(-1)?.payload).toMatchObject({ category: "protected", omitted_events: 1 });
  });
});
