import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCodexRolloutExecEvents,
  recoverCodexRolloutExecEvents
} from "./rolloutExecRecovery.ts";

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

  test("recovers direct exec_command function calls with their real process exit code", () => {
    const source = [
      row("2026-07-31T07:26:09.470Z", {
        type: "function_call",
        id: "fc-test",
        call_id: "call-direct",
        name: "exec_command",
        arguments: JSON.stringify({
          cmd: "python3 -m unittest discover -s /tmp -p 'test_issue_815.py' -v",
          workdir: "/repo"
        })
      }),
      row("2026-07-31T07:26:10.037Z", {
        type: "function_call_output",
        call_id: "call-direct",
        output: [
          "Chunk ID: fixture",
          "Wall time: 0.4 seconds",
          "Process exited with code 0",
          "Final output:",
          "Ran 9 tests",
          "OK"
        ].join("\n")
      })
    ].join("\n");

    const events = parseCodexRolloutExecEvents(source, {
      threadID: "thread-direct",
      turnID: "turn-direct"
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      command: "python3 -m unittest discover -s /tmp -p 'test_issue_815.py' -v",
      status: "completed",
      type: "tool"
    });
    expect(JSON.parse(String(events[0]!.raw!.payload))).toMatchObject({
      item: {
        exitCode: 0,
        id: "fc-test",
        status: "completed",
        type: "commandExecution"
      }
    });
  });

  test("finds a UUIDv7 thread rollout when thread/start omits path", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codex-rollout-recovery-"));
    const threadID = "019fb766-11a2-7011-9621-56c0c6195d5f";
    const turnID = "019fb766-1d96-7341-b327-1c1b6401d79f";
    const directory = join(codexHome, "sessions", "2026", "07", "31");
    const source = [
      row("2026-07-31T09:00:42.543Z", {
        type: "function_call",
        id: "fc-contract-test",
        call_id: "call-contract-test",
        name: "exec_command",
        arguments: JSON.stringify({
          cmd: "pnpm --filter @fuzhuang/api-contract test",
          workdir: "/repo"
        }),
        internal_chat_message_metadata_passthrough: { turn_id: turnID }
      }),
      row("2026-07-31T09:00:49.966Z", {
        type: "function_call_output",
        call_id: "call-contract-test",
        output: [
          "Chunk ID: fixture",
          "Wall time: 7.2 seconds",
          "Process exited with code 0",
          "Final output:",
          "Tests 9 passed (9)"
        ].join("\n"),
        internal_chat_message_metadata_passthrough: { turn_id: turnID }
      })
    ].join("\n");

    try {
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, `rollout-2026-07-31T16-59-07-${threadID}.jsonl`),
        source
      );

      const events = await recoverCodexRolloutExecEvents({
        ephemeral: false,
        id: `codex:${threadID}`,
        provider: "codex",
        provider_session_id: threadID,
        sessionId: threadID
      }, turnID, { codexHome });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        command: "pnpm --filter @fuzhuang/api-contract test",
        status: "completed",
        type: "tool"
      });
    } finally {
      await rm(codexHome, { force: true, recursive: true });
    }
  });
});

function row(timestamp: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp, type: "response_item", payload });
}
