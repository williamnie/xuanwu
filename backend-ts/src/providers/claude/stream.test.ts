import { describe, expect, test } from "bun:test";
import { parseClaudeStreamJSONL } from "./stream.ts";

const RUN_ID = "cli:claude:182";

describe("Claude stream-json parser", () => {
  test("normalizes text, tool, unknown raw, and done events", () => {
    const input = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" }),
      JSON.stringify({
        type: "assistant",
        message: { content: [
          { type: "text", text: "hello ANTHROPIC_API_KEY=secret-value" },
          { type: "tool_use", name: "Bash", input: { command: "echo ok" } }
        ] }
      }),
      JSON.stringify({ type: "user", tool_use_result: { type: "tool_result", content: "tool output" } }),
      JSON.stringify({ type: "mystery", token: "fixture-secret", details: { ok: true } }),
      JSON.stringify({ type: "result", session_id: "sess-1", uuid: "turn-1", is_error: false, terminal_reason: "end_turn" })
    ].join("\n") + "\n";

    const result = parseClaudeStreamJSONL(input, { runId: RUN_ID, secrets: ["secret-value", "fixture-secret"] });

    expect(result.completed).toBe(true);
    expect(result.transient).toBe(false);
    expect(result.session).toEqual({ provider: "claude", sessionId: "sess-1", turnId: "turn-1" });
    expect(result.events.map((event) => event.type)).toEqual(["text", "text", "tool", "tool", "raw", "done"]);
    expect(result.events[1]).toMatchObject({
      provider: "claude",
      text: "hello ANTHROPIC_API_KEY=[redacted]",
      session: { provider: "claude", sessionId: "sess-1" }
    });
    expect(result.events[2]).toMatchObject({ type: "tool", command: "echo ok" });
    expect(result.events[3]).toMatchObject({ type: "tool", text: "tool output" });
    expect(result.events[4].payload).toContain("mystery");
    expect(String(result.events[4].payload).length).toBeLessThanOrEqual(248);
    expect(JSON.stringify(result.events[4])).not.toContain("fixture-secret");
    expect(result.events[4].runEvent).toMatchObject({
      kind: "unknown",
      outcome: "unknown",
      terminal: false,
      unknown: { policy: "preserve" }
    });
    expect(result.events.at(-1)).toMatchObject({
      type: "done",
      status: "end_turn",
      runEvent: { kind: "completed", outcome: "succeeded", terminal: true }
    });
  });

  test("normalizes Claude result errors without emitting done", () => {
    const input = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-err" }),
      JSON.stringify({ type: "result", session_id: "sess-err", uuid: "turn-err", is_error: true, result: "model failed" })
    ].join("\n") + "\n";

    const result = parseClaudeStreamJSONL(input, { runId: RUN_ID });

    expect(result.completed).toBe(false);
    expect(result.error).toBe("model failed");
    expect(result.events.map((event) => event.type)).toEqual(["text", "error"]);
    expect(result.events.at(-1)).toMatchObject({
      type: "error",
      status: "failed",
      error: "model failed",
      runEvent: { kind: "error", outcome: "failed", terminal: true }
    });
  });

  test("returns a transient diagnostic error for truncated streams", () => {
    const input = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-cut" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }),
      "{\"type\":\"result\",\"session_id\":\"sess-cut\",\"uuid\":"
    ].join("\n");

    const result = parseClaudeStreamJSONL(input, { runId: RUN_ID });

    expect(result.completed).toBe(false);
    expect(result.transient).toBe(true);
    expect(result.diagnostic).toContain("truncated");
    expect(result.events.map((event) => event.type)).toEqual(["text", "text", "error"]);
    expect(result.events.at(-1)).toMatchObject({ type: "error", status: "transient" });
  });
});
