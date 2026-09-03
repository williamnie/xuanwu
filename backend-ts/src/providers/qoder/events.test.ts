import { describe, expect, test } from "bun:test";
import type { SDKMessage, SDKResultMessage } from "@qoder-ai/qoder-agent-sdk";
import { projectQoderMessage, qoderFailureEvent, qoderResultFailure } from "./events.ts";
import { qoderMessageTerminal } from "./sdkFacade.ts";

function usage(): SDKResultMessage["usage"] {
  return {
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    cache_creation_input_tokens: 2,
    cache_read_input_tokens: 3,
    inference_geo: "",
    input_tokens: 5,
    iterations: [],
    output_tokens: 7,
    server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
    service_tier: "",
    speed: ""
  };
}

function result(overrides: Partial<SDKResultMessage> = {}): SDKResultMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 12,
    duration_api_ms: 8,
    is_error: false,
    num_turns: 1,
    result: "ok",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: usage(),
    modelUsage: {},
    permission_denials: [],
    uuid: "result-1",
    session_id: "session-1",
    ...overrides
  } as SDKResultMessage;
}

describe("Qoder Q2 native event projection", () => {
  test.each(["completed", "cancelled", "discarded"] as const)("protocol 1.3 command_lifecycle %s does not terminate the main Run", (state) => {
    const message = {
      type: "command_lifecycle", command_uuid: "command-1", state, uuid: "lifecycle-1", session_id: "session-1"
    } satisfies SDKMessage;
    const event = projectQoderMessage(message, { invocationRef: "inv-1" });
    expect(event.runEvent?.terminal).toBe(false);
    expect(qoderMessageTerminal(message)).toBeUndefined();
  });

  test("unknown native messages are preserved and nonterminal", () => {
    const event = projectQoderMessage({
      type: "cloud_agent_event",
      event: "future.event",
      data: { opaque: true, access_token: "fixture-secret" },
      uuid: "future-1",
      session_id: "session-1"
    } as SDKMessage, { invocationRef: "inv-1" });

    expect(event).toMatchObject({
      type: "unknown",
      raw: { method: "qoder/cloud_agent_event" },
      runEvent: {
        contract: "xw.run-event.v1",
        kind: "unknown",
        outcome: "unknown",
        terminal: false,
        unknown: { policy: "preserve" }
      }
    });
    expect(JSON.stringify(event)).not.toContain("fixture-secret");
  });

  test("assistant tool calls and retry messages stay progress events", () => {
    const tool = projectQoderMessage({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { path: "/tmp/a" } }] },
      parent_tool_use_id: null,
      uuid: "assistant-1",
      session_id: "session-1"
    }, { invocationRef: "inv-1" });
    const retry = projectQoderMessage({
      type: "system",
      subtype: "api_retry",
      attempt: 1,
      max_retries: 3,
      retry_delay_ms: 10,
      error_status: 503,
      error: "server_error",
      uuid: "retry-1",
      session_id: "session-1"
    }, { invocationRef: "inv-1" });

    expect(tool).toMatchObject({ type: "tool_call", runEvent: { kind: "progress", terminal: false } });
    expect(retry).toMatchObject({
      type: "provider.retry",
      runEvent: { kind: "progress", retryable: true, terminal: false }
    });
  });

  test("result UUID is the message ref and usage is attached only to the main terminal", () => {
    const event = projectQoderMessage(result(), { invocationRef: "inv-result" });
    expect(event).toMatchObject({
      session: { sessionId: "session-1", turnId: "result-1" },
      runEvent: {
        kind: "completed",
        metadata: { invocation_ref: "inv-result", message_ref: "result-1" },
        outcome: "succeeded",
        terminal: true,
        cost: { usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 } }
      }
    });
  });

  test("typed result and process failures preserve codes while redacting summaries", () => {
    const failed = result({
      subtype: "error_during_execution",
      is_error: true,
      errors: ["authorization: Basic fixture-secret"],
      error_code: 429
    });
    expect(qoderResultFailure(failed)).toMatchObject({ category: "transient", code: 429, retryable: true });

    const event = qoderFailureEvent({
      category: "process",
      code: "QODER_CLI_PROCESS_ERROR",
      errorClass: "QoderCliProcessError",
      exitCode: 17,
      message: "QODER_PERSONAL_ACCESS_TOKEN=fixture-secret",
      retryable: false,
      signal: "SIGTERM"
    }, "inv-process");
    expect(event).toMatchObject({
      raw: {
        payload: {
          error_category: "process",
          error_class: "QoderCliProcessError",
          error_code: "QODER_CLI_PROCESS_ERROR",
          exit_code: 17,
          process_signal: "SIGTERM"
        }
      },
      runEvent: { kind: "error", outcome: "failed", retryable: false, terminal: true }
    });
    expect(JSON.stringify(event)).not.toContain("fixture-secret");
  });
});
