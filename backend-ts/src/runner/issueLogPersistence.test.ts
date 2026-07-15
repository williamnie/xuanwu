import { describe, expect, test } from "bun:test";
import type { ProviderEvent } from "../providers/types.ts";
import { createIssueLogPersistence } from "./issueLogPersistence.ts";

const session = { provider: "codex" as const, sessionId: "thread-long", turnId: "turn-long" };

describe("issue.log persistence reduction", () => {
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

    expect(persisted).toHaveLength(9);
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
});
