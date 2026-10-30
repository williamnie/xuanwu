import { normalizedRunEvent, providerEventSourceRef, providerRunCost, unknownRunEvent } from "../runEvents.ts";
import type { NormalizedRunEvent, ProviderEvent, SessionRef } from "../types.ts";
import { ParseState, PROVIDER } from "./stream.ts";
import { rawSummary, stringField, recordField, numericField, usdMicros, stableJSON, redactPayload } from "./streamValues.ts";

export function markTransient(state: ParseState, message: string): void {
  state.transient = true;
  state.diagnostic = message;
  state.error = message;
  const session = sessionRef(state);
  state.events.push({
    provider: PROVIDER,
    type: "error",
    status: "transient",
    error: message,
    session,
    runEvent: normalizedRunEvent({
      kind: "error",
      method: "stream/truncated",
      outcome: "failed",
      provider: PROVIDER,
      retryable: true,
      session
    })
  });
}

export function textEvent(text: string, state: ParseState, raw: ProviderEvent["raw"], type = "text"): ProviderEvent[] {
  if (text === "") return [];
  const session = sessionRef(state);
  return [{
    provider: PROVIDER,
    type,
    text,
    session,
    raw,
    runEvent: normalizedRunEvent({ kind: "progress", method: raw?.method ?? type, outcome: "running", provider: PROVIDER, session })
  }];
}

export function toolEvent(command: string, state: ParseState, raw: ProviderEvent["raw"]): ProviderEvent {
  const session = sessionRef(state);
  return {
    provider: PROVIDER,
    type: "tool",
    command,
    session,
    raw,
    runEvent: normalizedRunEvent({ kind: "progress", method: raw?.method ?? "assistant", outcome: "running", provider: PROVIDER, session })
  };
}

export function rawSummaryEvent(record: Record<string, unknown>, state: ParseState, raw: ProviderEvent["raw"]): ProviderEvent {
  const payload = rawSummary(stringField(record, "type") || "unknown", raw?.payload ?? "");
  const session = sessionRef(state);
  return {
    provider: PROVIDER,
    type: "raw",
    payload,
    session,
    raw,
    runEvent: unknownRunEvent(PROVIDER, raw?.method ?? "unknown", session)
  };
}

export function claudeResultRunEvent(
  record: Record<string, unknown>,
  session: SessionRef,
  kind: "completed" | "error",
  outcome: "succeeded" | "failed"
): NormalizedRunEvent {
  const usage = recordField(record, "usage");
  const inputTokens = numericField(usage, "input_tokens");
  const outputTokens = numericField(usage, "output_tokens");
  const totalTokens = numericField(usage, "total_tokens") ?? (
    inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined
  );
  const sourceRef = providerEventSourceRef(PROVIDER, "result", session);
  const amountMicros = usdMicros(record["total_cost_usd"]);
  const cost = providerRunCost({
    amountMicros,
    currency: amountMicros === null ? "" : "USD",
    sourceRef,
    usage: {
      cached_input_tokens: numericField(usage, "cache_read_input_tokens"),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      reasoning_output_tokens: numericField(usage, "reasoning_output_tokens"),
      total_tokens: totalTokens
    }
  });
  return normalizedRunEvent({
    ...(cost ? { cost } : {}),
    kind,
    metadata: {
      duration_api_ms: numericField(record, "duration_api_ms"),
      duration_ms: numericField(record, "duration_ms"),
      models: Object.keys(recordField(record, "modelUsage")).sort().join(","),
      num_turns: numericField(record, "num_turns"),
      stop_reason: stringField(record, "terminal_reason") || stringField(record, "stop_reason"),
      usage_scope: "attempt"
    },
    method: "result",
    outcome,
    provider: PROVIDER,
    session
  });
}

export function rawEvent(record: Record<string, unknown>, state: ParseState): ProviderEvent["raw"] {
  return { method: stringField(record, "type") || "unknown", payload: stableJSON(redactPayload(record, state)) };
}

export function sessionRef(state: ParseState): SessionRef {
  const sessionId = state.sessionId || state.runId;
  return { provider: PROVIDER, sessionId, ...(state.turnId ? { turnId: state.turnId } : {}) };
}
