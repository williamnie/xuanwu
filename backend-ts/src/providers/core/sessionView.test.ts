import { describe, expect, test } from "bun:test";
import { assertProviderSessionView, providerSessionDetail, providerSessionSummary } from "./sessionView.ts";

describe("provider-neutral Session View", () => {
  test("normalizes different adapter candidates into one public identity contract", () => {
    const pi = providerSessionDetail("pi-coding-agent", {
      sessionRef: "pi-1",
      cwd: "/tmp/pi",
      model: "deepseek/deepseek-v4-flash",
      turns: [{ id: "turn-1", items: [{ type: "agentMessage", text: "done" }] }]
    });
    const claude = providerSessionDetail("claude", {
      sessionRef: "claude-1",
      status: "idle",
      turns: [{ id: "turn-1", items: [{ type: "agentMessage", text: "done" }] }]
    });

    for (const detail of [pi, claude]) {
      expect(detail.session_contract).toBe("xw.provider-session.v1");
      expect(detail.id).toBe(`${detail.provider}:${detail.provider_session_id}`);
      expect(detail.sessionId).toBe(detail.provider_session_id);
      expect(detail.thread_id).toBe(detail.provider_session_id);
      expect(detail.turns).toHaveLength(1);
    }
  });

  test("preserves adapter-selected extensions without allowing identity override", () => {
    const summary = providerSessionSummary("codex", {
      sessionRef: "thread-1",
      status: { type: "notLoaded" },
      extensions: {
        id: "native-id",
        provider: "native",
        model: "native-model",
        turns: [{ id: "native-turn", items: [] }],
        path: "/tmp/rollout.jsonl"
      }
    });

    expect(summary).toMatchObject({
      id: "codex:thread-1",
      provider: "codex",
      provider_session_id: "thread-1",
      path: "/tmp/rollout.jsonl",
      status: { type: "notLoaded" }
    });
    expect(summary).not.toHaveProperty("model");
    expect(summary).not.toHaveProperty("turns");
  });

  test("fails closed when an opted-in adapter leaks its native session shape", () => {
    expect(() => assertProviderSessionView("claude", {
      sessionId: "claude-1",
      type: "assistant",
      message: { content: "native payload" }
    })).toThrow("invalid xw.provider-session.v1 view");
    expect(() => assertProviderSessionView("claude", providerSessionSummary("claude", {
      sessionRef: "claude-1"
    }))).not.toThrow();
    expect(() => assertProviderSessionView("claude", providerSessionSummary("claude", {
      sessionRef: "claude-1"
    }), { detail: true })).toThrow("invalid xw.provider-session.v1 view");
  });
});
