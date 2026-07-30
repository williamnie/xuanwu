import { redactSensitiveText } from "../../util/redact.ts";
import { redactRegisteredSecrets } from "../../security/redactionRegistry.ts";
import { normalizedRunEvent, providerRunCost, unknownRunEvent } from "../runEvents.ts";
import type { ProviderEvent, SessionRef } from "../types.ts";

const PROVIDER = "claude" as const;
const RAW_LIMIT = 2_000;

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
  const type = stringValue(record.type) || "unknown";
  const subtype = stringValue(record.subtype);
  state.sessionId = stringValue(record.session_id) || state.sessionId;
  state.turnId = stringValue(record.uuid) || state.turnId;
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
          claude_code_version: stringValue(record.claude_code_version),
          model: stringValue(record.model),
          permission_mode: stringValue(record.permissionMode),
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
      status: stringValue(record.status) || "running",
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

function assistantEvents(
  record: Record<string, unknown>,
  state: ClaudeSdkStreamState,
  raw: ProviderEvent["raw"],
  method: string
): ProviderEvent[] {
  const message = objectValue(record.message);
  const partialTextSeen = state.partialTextSeen;
  state.partialTextSeen = false;
  return arrayValue(message.content).flatMap((item) => {
    const block = objectValue(item);
    const session = sessionRef(state);
    if (block.type === "text") {
      const text = safeText(block.text);
      // includePartialMessages emits the same assistant text once as deltas and
      // again as the completed message. Keep the stream incremental without
      // buffering or rendering the completed copy twice.
      return text === "" || partialTextSeen ? [] : [event({
        method,
        raw,
        runEvent: progressRunEvent(method, session),
        session,
        text,
        type: "text"
      })];
    }
    if (block.type === "tool_use") {
      return [event({
        command: toolSummary(block),
        method,
        payload: redactRegisteredSecrets(block.input),
        raw,
        runEvent: progressRunEvent(method, session),
        session,
        status: "started",
        type: "tool"
      })];
    }
    return [];
  });
}

function toolResultEvents(
  record: Record<string, unknown>,
  state: ClaudeSdkStreamState,
  raw: ProviderEvent["raw"],
  method: string
): ProviderEvent[] {
  const message = objectValue(record.message);
  return arrayValue(message.content).flatMap((item) => {
    const block = objectValue(item);
    if (block.type !== "tool_result") return [];
    const session = sessionRef(state);
    return [event({
      method,
      payload: redactRegisteredSecrets(block.content),
      raw,
      runEvent: progressRunEvent(method, session),
      session,
      status: block.is_error === true ? "failed" : "completed",
      text: contentText(block.content),
      type: "tool_result"
    })];
  });
}

function partialEvents(
  record: Record<string, unknown>,
  state: ClaudeSdkStreamState,
  raw: ProviderEvent["raw"],
  method: string
): ProviderEvent[] {
  const delta = objectValue(objectValue(record.event).delta);
  const text = safeText(delta.text);
  if (text === "") return [];
  state.partialTextSeen = true;
  const session = sessionRef(state);
  return [event({
    method,
    raw,
    runEvent: progressRunEvent(method, session),
    session,
    status: "streaming",
    text,
    type: "text_delta"
  })];
}

function resultEvent(
  record: Record<string, unknown>,
  state: ClaudeSdkStreamState,
  raw: ProviderEvent["raw"],
  method: string
): ProviderEvent {
  state.terminal = true;
  const failed = record.is_error === true || stringValue(record.subtype) !== "success";
  state.completed = !failed;
  const session = sessionRef(state);
  const error = failed ? resultError(record) : "";
  const status = stringValue(record.terminal_reason) || stringValue(record.stop_reason) || (failed ? "failed" : "completed");
  const cost = resultCost(record, method, session);
  return event({
    ...(failed ? { error } : { text: safeText(record.result) }),
    method,
    raw,
    runEvent: normalizedRunEvent({
      ...(cost ? { cost } : {}),
      kind: failed ? "error" : "completed",
      metadata: {
        duration_api_ms: numberValue(record.duration_api_ms),
        duration_ms: numberValue(record.duration_ms),
        num_turns: numberValue(record.num_turns),
        result_subtype: stringValue(record.subtype),
        terminal_reason: stringValue(record.terminal_reason)
      },
      method,
      outcome: failed ? "failed" : "succeeded",
      provider: PROVIDER,
      session
    }),
    session,
    status,
    type: failed ? "error" : "done"
  });
}

function resultCost(record: Record<string, unknown>, method: string, session: SessionRef | undefined) {
  const usage = objectValue(record.usage);
  const uncached = tokenValue(usage.input_tokens);
  const cached = tokenValue(usage.cache_read_input_tokens);
  const cacheCreation = tokenValue(usage.cache_creation_input_tokens);
  const output = tokenValue(usage.output_tokens);
  const input = sumKnown(uncached, cached, cacheCreation);
  return providerRunCost({
    amountMicros: usdMicros(record.total_cost_usd),
    currency: "USD",
    sourceRef: ["provider-event", PROVIDER, method, session?.sessionId || "no-session", session?.turnId || "no-turn"].join(":"),
    usage: {
      cached_input_tokens: cached,
      input_tokens: input,
      output_tokens: output,
      reasoning_output_tokens: null,
      total_tokens: input === null || output === null ? null : input + output
    }
  });
}

function unknownEvent(
  record: Record<string, unknown>,
  state: ClaudeSdkStreamState,
  raw: ProviderEvent["raw"],
  method: string
): ProviderEvent {
  const session = sessionRef(state);
  return event({
    method,
    payload: raw?.payload,
    raw,
    runEvent: unknownRunEvent(PROVIDER, method, session),
    session,
    status: "diagnostic",
    text: `Unsupported Claude SDK event preserved: ${method}`,
    type: "unknown"
  });
}

function progressRunEvent(method: string, session?: SessionRef) {
  return normalizedRunEvent({ kind: "progress", method, outcome: "running", provider: PROVIDER, session });
}

function sessionRef(state: ClaudeSdkStreamState): SessionRef | undefined {
  if (state.sessionId === "") return undefined;
  return {
    provider: PROVIDER,
    sessionId: state.sessionId,
    ...(state.turnId === "" ? {} : { turnId: state.turnId })
  };
}

function event(input: Omit<ProviderEvent, "provider"> & { method: string }): ProviderEvent {
  const { method: _method, ...rest } = input;
  return { provider: PROVIDER, ...rest };
}

function resultError(record: Record<string, unknown>): string {
  const errors = arrayValue(record.errors).map(safeText).filter(Boolean);
  return errors.join("; ") || safeText(record.result) || `Claude SDK result failed: ${stringValue(record.subtype) || "unknown"}`;
}

function toolSummary(block: Record<string, unknown>): string {
  const name = stringValue(block.name) || "tool";
  const input = rawSummary(objectValue(block.input));
  return input === "{}" ? name : `${name} ${input}`;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return safeText(value);
  return arrayValue(value).map((item) => {
    const record = objectValue(item);
    return safeText(record.text || record.content);
  }).filter(Boolean).join("\n");
}

function rawSummary(value: unknown): string {
  let text = "";
  try {
    text = JSON.stringify(redactRegisteredSecrets(value));
  } catch {
    text = String(value);
  }
  const redacted = redactSensitiveText(text);
  return redacted.length <= RAW_LIMIT ? redacted : `${redacted.slice(0, RAW_LIMIT)}…`;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeText(value: unknown): string {
  return redactSensitiveText(typeof value === "string" ? value : "");
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function tokenValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function sumKnown(...values: Array<number | null>): number | null {
  return values.every((value) => value === null) ? null : values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function usdMicros(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 1_000_000);
}
