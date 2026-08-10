import { describe, expect, test } from "bun:test";
import { durableProviderSessionRef, providerSessionStartedEvent } from "./sessionLifecycle.ts";

describe("provider-neutral Session lifecycle", () => {
  test("builds one durable start event for any Code Agent adapter", () => {
    for (const provider of ["codex", "claude", "pi-coding-agent"] as const) {
      expect(providerSessionStartedEvent(provider, `${provider}-session`, {
        method: `${provider}/session_started`
      })).toMatchObject({
        provider,
        session: { provider, sessionId: `${provider}-session` },
        status: "running",
        type: "provider.session_started",
        runEvent: {
          contract: "xw.run-event.v1",
          kind: "started",
          outcome: "running",
          terminal: false
        }
      });
    }
  });

  test("rejects empty durable identities", () => {
    expect(() => durableProviderSessionRef("claude", " ")).toThrow("empty durable session ref");
  });
});
