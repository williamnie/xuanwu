import { describe, expect, test } from "bun:test";
import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  assertClaudeSessionHistoryIdentity,
  publicClaudeSessionDetail
} from "./sessionHistory.ts";

describe("Claude Session history projection", () => {
  test("projects user, reasoning, assistant, and tool items into the shared detail contract", () => {
    const messages = [{
      type: "user",
      uuid: "user-1",
      session_id: "session-1",
      message: { content: "inspect" }
    }, {
      type: "assistant",
      uuid: "assistant-1",
      session_id: "session-1",
      message: { content: [
        { type: "thinking", thinking: "reason" },
        { type: "text", text: "done" },
        { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } }
      ] }
    }, {
      type: "user",
      uuid: "tool-result-1",
      session_id: "session-1",
      message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "contents" }] }
    }] as unknown as SessionMessage[];

    const detail = publicClaudeSessionDetail("session-1", undefined, messages);

    expect(detail.session_contract).toBe("xw.provider-session.v1");
    expect(detail.turns[0]?.items).toMatchObject([
      { type: "userMessage" },
      { type: "reasoning" },
      { type: "agentMessage" },
      { type: "custom_tool_call" },
      { id: "tool-1", type: "custom_tool_call_output" }
    ]);
  });

  test("fails closed when metadata or transcript belongs to another Session", () => {
    const info = { sessionId: "session-b" } as SDKSessionInfo;
    expect(() => assertClaudeSessionHistoryIdentity("session-a", info, [])).toThrow("mismatched history session-b");
    const messages = [{ session_id: "session-b" }] as unknown as SessionMessage[];
    expect(() => assertClaudeSessionHistoryIdentity("session-a", undefined, messages)).toThrow("mismatched history session-b");
  });
});
