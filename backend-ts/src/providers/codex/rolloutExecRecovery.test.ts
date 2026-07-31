import { describe, expect, test } from "bun:test";
import { parseCodexRolloutExecEvents } from "./rolloutExecRecovery.ts";

describe("Codex rollout exec recovery", () => {
  test("recovers a completed unified exec command omitted by live notifications", () => {
    const source = [
      row("2026-07-31T07:06:18.800Z", {
        type: "custom_tool_call",
        id: "ctc-test",
        call_id: "call-test",
        name: "exec",
        input: [
          `const r = await tools.exec_command({"cmd":"python3 -m unittest discover -s /tmp -p 'test_issue_815.py' -v","workdir":"/repo"});`,
          "text(r.output);"
        ].join("\n"),
        internal_chat_message_metadata_passthrough: { turn_id: "turn-1" }
      }),
      row("2026-07-31T07:06:19.309Z", {
        type: "custom_tool_call_output",
        call_id: "call-test",
        output: [
          { type: "input_text", text: "Script completed\nWall time 0.5 seconds\nOutput:\n" },
          { type: "input_text", text: '{"exit_code":0,"output":"Ran 8 tests\\nOK"}' }
        ],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-1" }
      })
    ].join("\n");

    const events = parseCodexRolloutExecEvents(source, {
      threadID: "thread-1",
      turnID: "turn-1"
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      command: "python3 -m unittest discover -s /tmp -p 'test_issue_815.py' -v",
      provider: "codex",
      session: { provider: "codex", sessionId: "thread-1", turnId: "turn-1" },
      status: "completed",
      type: "tool"
    });
    expect(JSON.parse(String(events[0]!.raw!.payload))).toMatchObject({
      item: {
        contentItems: expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining("Ran 8 tests") })
        ]),
        id: "ctc-test",
        type: "dynamicToolCall"
      }
    });
  });

  test("ignores other turns, incomplete calls, non-exec tools, and malformed rows", () => {
    const source = [
      "{not-json",
      row("2026-07-31T07:00:00.000Z", {
        type: "custom_tool_call",
        id: "ctc-other",
        call_id: "call-other",
        name: "exec",
        input: 'const r = await tools.exec_command({"cmd":"bun test"}); text(r.output);',
        internal_chat_message_metadata_passthrough: { turn_id: "turn-other" }
      }),
      row("2026-07-31T07:00:01.000Z", {
        type: "custom_tool_call_output",
        call_id: "call-other",
        output: [{ type: "input_text", text: "Script completed\nOutput:\npass" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-other" }
      }),
      row("2026-07-31T07:00:02.000Z", {
        type: "custom_tool_call",
        id: "ctc-image",
        call_id: "call-image",
        name: "imagegen",
        input: "{}",
        internal_chat_message_metadata_passthrough: { turn_id: "turn-1" }
      }),
      row("2026-07-31T07:00:03.000Z", {
        type: "custom_tool_call",
        id: "ctc-running",
        call_id: "call-running",
        name: "exec",
        input: 'const r = await tools.exec_command({"cmd":"bun test"}); text(r.output);',
        internal_chat_message_metadata_passthrough: { turn_id: "turn-1" }
      }),
      row("2026-07-31T07:00:04.000Z", {
        type: "custom_tool_call_output",
        call_id: "call-running",
        output: [{ type: "input_text", text: "Script running with cell ID 123" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-1" }
      })
    ].join("\n");

    expect(parseCodexRolloutExecEvents(source, {
      threadID: "thread-1",
      turnID: "turn-1"
    })).toEqual([]);
  });

  test("fails closed when rollout output omits the nested command exit code", () => {
    const source = [
      row("2026-07-31T07:06:18.800Z", {
        type: "custom_tool_call",
        id: "ctc-ambiguous",
        call_id: "call-ambiguous",
        name: "exec",
        input: 'const r = await tools.exec_command({"cmd":"bun test"}); text(r.output);',
        internal_chat_message_metadata_passthrough: { turn_id: "turn-1" }
      }),
      row("2026-07-31T07:06:19.309Z", {
        type: "custom_tool_call_output",
        call_id: "call-ambiguous",
        output: [{ type: "input_text", text: "Script completed\nOutput:\n1 pass" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-1" }
      })
    ].join("\n");

    expect(parseCodexRolloutExecEvents(source, {
      threadID: "thread-1",
      turnID: "turn-1"
    })).toEqual([]);
  });
});

function row(timestamp: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp, type: "response_item", payload });
}
