import { describe, expect, test } from "bun:test";
import { normalizeCodexEvent } from "./events.ts";

describe("Codex event normalization", () => {
  test("extracts thread status changes so runtime can persist stopped sessions", () => {
    const event = normalizeCodexEvent({
      method: "thread/status/changed",
      params: {
        threadId: "thread-idle",
        status: { type: "idle" }
      }
    });

    expect(event).toMatchObject({
      provider: "codex",
      raw: { method: "thread/status/changed" },
      session: { provider: "codex", sessionId: "thread-idle" },
      status: "idle",
      type: "raw",
      runEvent: { contract: "xw.run-event.v1", kind: "progress", outcome: "running", terminal: false }
    });
  });

  test("preserves unsupported wire notifications as non-terminal unknown events", () => {
    const event = normalizeCodexEvent({
      method: "future/providerSignal",
      params: { threadId: "thread-future", opaque: { value: true } }
    });

    expect(event).toMatchObject({
      provider: "codex",
      type: "raw",
      runEvent: {
        kind: "unknown",
        outcome: "unknown",
        terminal: false,
        unknown: { policy: "preserve", reason: "unsupported_provider_event" }
      }
    });
  });

  test("normalizes a completed unified exec dynamic tool as a command event", () => {
    const event = normalizeCodexEvent({
      method: "item/completed",
      params: {
        threadId: "thread-dynamic",
        turnId: "turn-dynamic",
        item: {
          type: "dynamicToolCall",
          id: "dynamic-1",
          tool: "exec",
          status: "completed",
          success: true,
          arguments: 'const r = await tools.exec_command({"cmd":"node --test src/example.test.js","workdir":"/repo"}); text(r.output);',
          contentItems: [{ type: "inputText", text: "Script completed\nOutput:\n1 pass" }]
        }
      }
    });

    expect(event).toMatchObject({
      command: "node --test src/example.test.js",
      status: "completed",
      type: "tool"
    });
  });
});
