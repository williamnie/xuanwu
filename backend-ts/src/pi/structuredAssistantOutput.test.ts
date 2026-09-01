import { describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxThinking } from "@earendil-works/pi-ai/compat";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { parseStructuredAssistantOutput, structuredAssistantProviderError } from "./structuredAssistantOutput.ts";

describe("structured assistant output compatibility", () => {
  test("prefers public text and validates it with the caller parser", () => {
    const session = fakeSession(fauxAssistantMessage('{"decision":"send"}'));
    expect(parseStructuredAssistantOutput(session, parseDecision)).toEqual({
      raw: '{"decision":"send"}',
      source: "text",
      value: { decision: "send" }
    });
  });

  test("accepts a schema-valid thinking-only final payload", () => {
    const session = fakeSession(fauxAssistantMessage(
      fauxThinking('{"decision":"send"}'),
      { stopReason: "stop" }
    ));
    expect(parseStructuredAssistantOutput(session, parseDecision)).toEqual({
      raw: '{"decision":"send"}',
      source: "thinking_compat",
      value: { decision: "send" }
    });
  });

  test("never treats tool-use or invalid thinking as a structured result", () => {
    const toolUse = fakeSession(fauxAssistantMessage(
      fauxThinking('{"decision":"send"}'),
      { stopReason: "toolUse" }
    ));
    const invalid = fakeSession(fauxAssistantMessage(fauxThinking("not json"), { stopReason: "stop" }));
    expect(parseStructuredAssistantOutput(toolUse, parseDecision)).toEqual({ raw: "", source: "none", value: null });
    expect(parseStructuredAssistantOutput(invalid, parseDecision)).toEqual({
      raw: "not json",
      source: "thinking_compat",
      value: null
    });
  });

  test("does not replace invalid public text with hidden thinking", () => {
    const message = fauxAssistantMessage([
      fauxThinking('{"decision":"send"}'),
      { type: "text", text: "not json" }
    ], { stopReason: "stop" });
    expect(parseStructuredAssistantOutput(fakeSession(message), parseDecision)).toEqual({
      raw: "not json",
      source: "text",
      value: null
    });
  });

  test("reports Provider errors separately from structured-output failures", () => {
    const session = fakeSession(fauxAssistantMessage([], {
      errorMessage: "provider overloaded",
      stopReason: "error"
    }), "session transport failed");
    expect(structuredAssistantProviderError(session)).toBe("session transport failed");
  });
});

function fakeSession(message: ReturnType<typeof fauxAssistantMessage>, errorMessage = "") {
  return {
    getLastAssistantText: () => message.content
      .filter((item) => item.type === "text")
      .map((item) => item.type === "text" ? item.text : "")
      .join("") || undefined,
    state: { errorMessage, messages: [message] }
  } as Pick<AgentSession, "getLastAssistantText" | "state">;
}

function parseDecision(raw: string): { decision: string } | null {
  try {
    const value = JSON.parse(raw) as { decision?: unknown };
    return value.decision === "send" ? { decision: value.decision } : null;
  } catch {
    return null;
  }
}
