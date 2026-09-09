import { describe, expect, test } from "bun:test";
import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  assertClaudeSessionHistoryIdentity,
  publicClaudeSessionDetail,
  assertClaudeSessionHistoryBudget,
  readBoundedClaudeSessionHistory,
  CLAUDE_HISTORY_FILE_BYTES,
  CLAUDE_HISTORY_MESSAGE_LIMIT,
  CLAUDE_HISTORY_TEXT_BYTES
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


test("Claude oversized source is rejected before the SDK reads its transcript", async () => {
  let calls = 0;
  await expect(readBoundedClaudeSessionHistory("session", {
    sessionId: "session", summary: "large", lastModified: 0, fileSize: CLAUDE_HISTORY_FILE_BYTES + 1,
  }, async () => { calls++; return []; })).rejects.toThrow("64 MiB source limit");
  expect(calls).toBe(0);
});

test("Claude asks for one overflow sentinel and fails explicitly instead of truncating turns", async () => {
  const message = { type: "user", uuid: "user", session_id: "session", message: { content: "hi" } } as SessionMessage;
  await expect(readBoundedClaudeSessionHistory("session", undefined, async (_id, options) => {
    expect(options).toMatchObject({ includeSystemMessages: false, offset: 0, limit: CLAUDE_HISTORY_MESSAGE_LIMIT + 1 });
    return Array.from({ length: CLAUDE_HISTORY_MESSAGE_LIMIT + 1 }, () => message);
  })).rejects.toThrow("10000 messages");
});

test("Claude content and object budgets apply without serializing untrusted payloads", () => {
  const message = (content: unknown) => [{ type: "assistant", uuid: "large", message: { content } }] as SessionMessage[];
  expect(() => assertClaudeSessionHistoryBudget(message("x".repeat(CLAUDE_HISTORY_TEXT_BYTES + 1))))
    .toThrow("32 MiB content limit");
  expect(() => assertClaudeSessionHistoryBudget(message(Array.from({ length: 250_001 }, () => null))))
    .toThrow("object complexity limit");
  let content: unknown = "leaf";
  for (let i = 0; i < 70; i++) content = { nested: content };
  expect(() => assertClaudeSessionHistoryBudget(message(content))).toThrow("object complexity limit");
  expect(() => assertClaudeSessionHistoryBudget(message({ toJSON() { throw new Error("must not serialize"); }, text: "small" }))).not.toThrow();
});

test("Claude SDK history concurrency is bounded and failure frees a slot", async () => {
  const releases: Array<() => void> = [];
  const reads = Array.from({ length: 4 }, () => readBoundedClaudeSessionHistory("session", undefined, async () => {
    await new Promise<void>((resolve) => releases.push(resolve));
    return [];
  }));
  await expect(readBoundedClaudeSessionHistory("session", undefined, async () => [])).rejects.toThrow("busy");
  for (const release of releases) release();
  await Promise.all(reads);
  await expect(readBoundedClaudeSessionHistory("session", undefined, async () => { throw new Error("SDK failure"); })).rejects.toThrow("SDK failure");
  expect(await readBoundedClaudeSessionHistory("session", undefined, async () => [])).toEqual([]);
});
