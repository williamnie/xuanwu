import { describe, expect, test } from "bun:test";
import type { SDKSessionInfo, SessionMessage } from "@qoder-ai/qoder-agent-sdk";
import { assertProviderSessionView } from "../core/sessionView.ts";
import {
  QODER_HISTORY_MESSAGE_LIMIT,
  assertQoderSessionHistoryIdentity,
  publicQoderSessionDetail,
  publicQoderSessionSummary,
  qoderTranscriptTurns,
  readQoderSessionHistory,
  type QoderSessionFunctions
} from "./sessionHistory.ts";

const info: SDKSessionInfo = {
  sessionId: "qoder-session-1",
  summary: "Qoder history",
  firstPrompt: "Inspect the runner",
  cwd: "/fixture/project",
  createdAt: 1_700_000_000_000,
  lastModified: 1_700_000_100_000,
  fileSize: 1234,
  gitBranch: "feature/qoder"
};

describe("Qoder Q3 session history adapter", () => {
  test("summary and detail implement the provider-neutral view with model/version/usage extensions", () => {
    const messages = fixtureMessages();
    const summary = publicQoderSessionSummary(info);
    const detail = publicQoderSessionDetail(info.sessionId, info, messages, {
      extensions: { provider_version: "1.0.23", sdk_version: "1.0.23" }
    });

    expect(() => assertProviderSessionView("qoder", summary)).not.toThrow();
    expect(() => assertProviderSessionView("qoder", detail, { detail: true })).not.toThrow();
    expect(detail).toMatchObject({
      session_contract: "xw.provider-session.v1",
      id: "qoder:qoder-session-1",
      model: "performance",
      provider_version: "1.0.23",
      sdk_version: "1.0.23",
      token_usage: {
        total_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
      }
    });
  });

  test("maps guarded native user, assistant, reasoning, command, file, tool, result, subagent, and permission items", () => {
    const turns = qoderTranscriptTurns(fixtureMessages());
    const items = turns.flatMap((turn) => turn.items);

    expect(items.map((item) => item.type)).toEqual([
      "userMessage",
      "reasoning",
      "commandExecution",
      "fileChange",
      "custom_tool_call",
      "subagent",
      "agentMessage",
      "custom_tool_call_output",
      "subagent",
      "permission",
      "qoderNative"
    ]);
    expect(items.find((item) => item.type === "commandExecution")).toMatchObject({ command: "bun test", cwd: "/fixture/project" });
    expect(items.find((item) => item.type === "fileChange")).toMatchObject({ path: "src/a.ts" });
    expect(items.find((item) => item.type === "custom_tool_call_output")).toMatchObject({ status: "completed" });
    expect(JSON.stringify(items)).not.toContain("fixture-secret");
  });

  test("malformed and future native history remains bounded and renderable instead of throwing", () => {
    const malformed = [
      { type: "assistant", uuid: "bad-1", session_id: "qoder-session-1", message: { content: [null, 42, { type: "future_block", token: "QODER_PERSONAL_ACCESS_TOKEN=fixture-secret" }] } },
      { type: "future_message", uuid: "bad-2", session_id: "qoder-session-1", opaque: { nested: true } }
    ] as unknown as SessionMessage[];

    const items = qoderTranscriptTurns(malformed).flatMap((turn) => turn.items);
    expect(items.every((item) => item.type === "qoderNative")).toBe(true);
    expect(items).toHaveLength(4);
    expect(JSON.stringify(items)).not.toContain("fixture-secret");
  });

  test("rejects mismatched provider history identity", () => {
    expect(() => assertQoderSessionHistoryIdentity("qoder-session-1", { ...info, sessionId: "other" }, [])).toThrow("mismatched history");
    expect(() => assertQoderSessionHistoryIdentity("qoder-session-1", info, [
      { type: "user", uuid: "u", session_id: "other", message: {}, parent_tool_use_id: null, parent_agent_id: null }
    ] as SessionMessage[])).toThrow("mismatched history");
  });

  test("reads large histories in fixed pages and stops at the hard limit", async () => {
    const messages = Array.from({ length: QODER_HISTORY_MESSAGE_LIMIT + 25 }, (_, index) => ({
      type: "user",
      uuid: `u-${index}`,
      session_id: info.sessionId,
      message: { role: "user", content: `message ${index}` },
      parent_tool_use_id: null,
      parent_agent_id: null
    })) as SessionMessage[];
    const calls: Array<{ limit?: number; offset?: number }> = [];
    const functions = sessionFunctions({
      async getSessionMessages(_sessionId, options) {
        calls.push({ limit: options?.limit, offset: options?.offset });
        return messages.slice(options?.offset ?? 0, (options?.offset ?? 0) + (options?.limit ?? messages.length));
      }
    });

    const history = await readQoderSessionHistory(functions, info.sessionId, info.cwd);
    expect(history.messages).toHaveLength(QODER_HISTORY_MESSAGE_LIMIT);
    expect(history.truncated).toBe(true);
    expect(calls).toHaveLength(5);
    expect(calls.every((call) => call.limit === 100)).toBe(true);
    expect(calls.map((call) => call.offset)).toEqual([0, 100, 200, 300, 400]);
  });
});

function fixtureMessages(): SessionMessage[] {
  return [
    {
      type: "user", uuid: "user-1", session_id: info.sessionId, parent_tool_use_id: null, parent_agent_id: null,
      message: { role: "user", content: "Inspect the runner" }
    },
    {
      type: "assistant", uuid: "assistant-1", session_id: info.sessionId, parent_tool_use_id: null, parent_agent_id: null,
      message: {
        role: "assistant",
        model: "performance",
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
        content: [
          { type: "thinking", thinking: "Check the provider chain" },
          { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "bun test", cwd: "/fixture/project" } },
          { type: "tool_use", id: "edit-1", name: "Edit", input: { file_path: "src/a.ts", new_string: "ok" } },
          { type: "tool_use", id: "tool-1", name: "WebSearch", input: { query: "Qoder" } },
          { type: "tool_use", id: "agent-1", name: "Task", input: { prompt: "review" } },
          { type: "text", text: "Done" }
        ]
      }
    },
    {
      type: "user", uuid: "result-1", session_id: info.sessionId, parent_tool_use_id: "bash-1", parent_agent_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "bash-1", content: "PASS" }] }
    },
    {
      type: "system", subtype: "task_notification", uuid: "task-1", session_id: info.sessionId,
      task_id: "task-1", status: "completed", summary: "Subagent done",
      usage: { total_tokens: 4, tool_uses: 1, duration_ms: 20 }, message: {}, parent_tool_use_id: null, parent_agent_id: null
    },
    {
      type: "system", subtype: "permission_denied", uuid: "permission-1", session_id: info.sessionId,
      tool_name: "Bash", tool_use_id: "bash-denied", message: "QODER_PERSONAL_ACCESS_TOKEN=fixture-secret",
      parent_tool_use_id: null, parent_agent_id: null
    },
    {
      type: "system", subtype: "future_history", uuid: "future-1", session_id: info.sessionId,
      payload: { future: true }, message: {}, parent_tool_use_id: null, parent_agent_id: null
    }
  ] as unknown as SessionMessage[];
}

function sessionFunctions(overrides: Partial<QoderSessionFunctions> = {}): QoderSessionFunctions {
  return {
    async getSessionInfo() { return info; },
    async getSessionMessages() { return []; },
    async listSessions() { return [info]; },
    ...overrides
  };
}
