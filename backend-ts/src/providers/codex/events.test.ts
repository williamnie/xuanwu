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
      type: "raw"
    });
  });
});
