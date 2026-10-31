import { normalizedRunEvent } from "../runEvents.ts";
import type { ProviderEvent } from "../types.ts";
import { cleanString, numberValue, objectValue } from "../../util/values.ts";
import { assistantEvents, toolResultEvents, partialEvents, resultEvent, unknownEvent } from "./sdkStreamMessages.ts";
import { rawSummary, sessionRef, event, safeText } from "./sdkStreamValues.ts";

export const PROVIDER = "claude" as const;

export const RAW_LIMIT = 2_000;

export type ClaudeSdkStreamState = {
  completed: boolean;
  interrupted: boolean;
  partialTextSeen: boolean;
  sessionId: string;
  terminal: boolean;
  turnId: string;
};

export function createClaudeSdkStreamState(): ClaudeSdkStreamState {
  return { completed: false, interrupted: false, partialTextSeen: false, sessionId: "", terminal: false, turnId: "" };
}

export function projectClaudeSdkMessage(message: unknown, state: ClaudeSdkStreamState): ProviderEvent[] {
  const record = objectValue(message);
  const type = cleanString(record.type) || "unknown";
  const subtype = cleanString(record.subtype);
  state.sessionId = cleanString(record.session_id) || state.sessionId;
  state.turnId = cleanString(record.uuid) || state.turnId;
  const method = subtype ? `${type}.${subtype}` : type;
  const raw = { method, payload: rawSummary(record) };

  if (type === "system" && subtype === "init") {
    const session = sessionRef(state);
    return [event({
      method,
      raw,
      runEvent: normalizedRunEvent({
        kind: "started",
        metadata: {
          claude_code_version: cleanString(record.claude_code_version),
          model: cleanString(record.model),
          permission_mode: cleanString(record.permissionMode),
          sdk_transport: "query"
        },
        method,
        outcome: "running",
        provider: PROVIDER,
        session
      }),
      session,
      status: "running",
      type: "turn_started"
    })];
  }
  if (type === "assistant") return assistantEvents(record, state, raw, method);
  if (type === "user") return toolResultEvents(record, state, raw, method);
  if (type === "stream_event") return partialEvents(record, state, raw, method);
  if (type === "result") return [resultEvent(record, state, raw, method)];
  if (type === "system" && subtype === "status") {
    const session = sessionRef(state);
    return [event({
      method,
      raw,
      runEvent: normalizedRunEvent({ kind: "progress", method, outcome: "running", provider: PROVIDER, session }),
      session,
      status: cleanString(record.status) || "running",
      type: "status"
    })];
  }
  if (type === "system" && subtype === "api_retry") {
    const session = sessionRef(state);
    return [event({
      error: safeText(record.error),
      method,
      raw,
      runEvent: normalizedRunEvent({
        kind: "progress",
        metadata: {
          attempt: numberValue(record.attempt),
          max_retries: numberValue(record.max_retries),
          retry_delay_ms: numberValue(record.retry_delay_ms)
        },
        method,
        outcome: "running",
        provider: PROVIDER,
        retryable: true,
        session
      }),
      session,
      status: "retrying",
      type: "error"
    })];
  }
  return [unknownEvent(record, state, raw, method)];
}

export function interruptedClaudeSdkEvent(state: ClaudeSdkStreamState, reason = "Claude SDK query interrupted"): ProviderEvent {
  state.interrupted = true;
  state.terminal = true;
  const session = sessionRef(state);
  return event({
    error: reason,
    method: "query.interrupted",
    raw: { method: "query.interrupted", payload: reason },
    runEvent: normalizedRunEvent({
      kind: "error",
      method: "query.interrupted",
      outcome: "interrupted",
      provider: PROVIDER,
      session
    }),
    session,
    status: "interrupted",
    type: "error"
  });
}

export function timedOutClaudeSdkEvent(state: ClaudeSdkStreamState, reason: string): ProviderEvent {
  state.terminal = true;
  const session = sessionRef(state);
  return event({
    error: safeText(reason),
    method: "query.timeout",
    raw: { method: "query.timeout", payload: safeText(reason) },
    runEvent: normalizedRunEvent({
      kind: "error",
      method: "query.timeout",
      outcome: "failed",
      provider: PROVIDER,
      retryable: true,
      session
    }),
    session,
    status: "timed_out",
    type: "error"
  });
}
