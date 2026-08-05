import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { piTranscriptTurns, publicPiSessionDetail } from "./sessionHistory.ts";

describe("Pi session history projection", () => {
  test("projects native Pi messages, reasoning, tools, and model into provider-neutral turns", () => {
    const entries = [
      { type: "model_change", id: "model", parentId: null, timestamp: "2026-08-05T00:00:00Z", provider: "deepseek", modelId: "deepseek-v4-flash" },
      { type: "message", id: "user", parentId: "model", timestamp: "2026-08-05T00:00:01Z", message: { role: "user", content: [{ type: "text", text: "你好" }], timestamp: 1 } },
      { type: "message", id: "assistant", parentId: "user", timestamp: "2026-08-05T00:00:02Z", message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "简短回复" },
          { type: "text", text: "你好！" },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }
        ],
        api: "openai-completions",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse",
        timestamp: 2
      } },
      { type: "message", id: "result", parentId: "assistant", timestamp: "2026-08-05T00:00:03Z", message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "contents" }],
        isError: false,
        timestamp: 3
      } }
    ] as SessionEntry[];

    expect(piTranscriptTurns(entries)).toEqual([{
      id: "user",
      items: [
        { id: "user", type: "userMessage", text: "你好" },
        { id: "assistant:0", type: "reasoning", content: [{ type: "text", text: "简短回复" }] },
        { id: "assistant:1", type: "agentMessage", text: "你好！" },
        { id: "call-1", type: "custom_tool_call", name: "read", input: { path: "README.md" } },
        { id: "call-1", type: "custom_tool_call_output", output: "contents", status: "completed" }
      ]
    }]);
    expect(publicPiSessionDetail({
      id: "pi-1",
      cwd: "/tmp/demo",
      name: "",
      entries,
      createdAt: 10,
      updatedAt: 20
    })).toMatchObject({
      id: "pi-coding-agent:pi-1",
      cwd: "/tmp/demo",
      model: "deepseek/deepseek-v4-flash",
      preview: "你好",
      status: "idle",
      turns: [{ id: "user" }]
    });
  });
});
