import { describe, expect, test } from "bun:test";
import { publicCodexSessionDetail } from "./sessionHistory.ts";

describe("Codex session adapter projection", () => {
  test("preserves native Codex fields behind the provider-neutral Session View", () => {
    const detail = publicCodexSessionDetail({
      id: "codex:thread-1",
      provider: "codex",
      provider_session_id: "thread-1",
      sessionId: "thread-1",
      ephemeral: false,
      path: "/tmp/rollout.jsonl",
      status: { type: "notLoaded" },
      turns: [{ id: "turn-1", items: [{ type: "agentMessage", text: "done" }] }]
    });

    expect(detail).toMatchObject({
      session_contract: "xw.provider-session.v1",
      id: "codex:thread-1",
      provider: "codex",
      provider_session_id: "thread-1",
      path: "/tmp/rollout.jsonl",
      status: { type: "notLoaded" },
      turns: [{ id: "turn-1", items: [{ type: "agentMessage", text: "done" }] }]
    });
  });
});
