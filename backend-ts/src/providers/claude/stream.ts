import { redactSensitiveText } from "../../util/redact.ts";
import { normalizedRunEvent, providerEventSourceRef, providerRunCost, unknownRunEvent } from "../runEvents.ts";
import type { NormalizedRunEvent, ProviderEvent, SessionRef } from "../types.ts";

const PROVIDER = "claude";
const RAW_LIMIT = 240;

export type ClaudeStreamParseOptions = { runId: string; secrets?: string[] };
export type ClaudeStreamParseResult = {
  completed: boolean;
  diagnostic?: string;
  error?: string;
  events: ProviderEvent[];
  session?: SessionRef;
  transient: boolean;
};

type ParseState = Required<Pick<ClaudeStreamParseOptions, "runId">> & {
  completed: boolean;
  diagnostic?: string;
  error?: string;
  events: ProviderEvent[];
  secrets: string[];
  sessionId: string;
  terminal: boolean;
  transient: boolean;
  turnId: string;
};

export function parseClaudeStreamJSONL(input: string, options: ClaudeStreamParseOptions): ClaudeStreamParseResult {
  const state = initialState(options);
  const lines = streamLines(input);
  const endsWithNewline = /\r?\n$/.test(input);
  for (const [index, line] of lines.entries()) parseLine(line, index, state, index === lines.length - 1 && !endsWithNewline);
  if (!state.terminal && !state.diagnostic) markTransient(state, "Claude stream-json truncated: missing result event");
  return {
    completed: state.completed,
    ...(state.diagnostic ? { diagnostic: state.diagnostic } : {}),
    ...(state.error ? { error: state.error } : {}),
    events: state.events,
    session: sessionRef(state),
    transient: state.transient
  };
}

function parseLine(line: string, index: number, state: ParseState, canBeTruncated: boolean): void {
  const text = line.trim();
  if (text === "") return;
  const record = parseRecord(text);
  if (!record) {
    if (canBeTruncated) markTransient(state, `Claude stream-json truncated at line ${index + 1}`);
    else state.events.push(rawSummaryEvent({ type: "invalid_json", line: text }, state, { method: "invalid_json", payload: redact(text, state) }));
    return;
  }
  state.sessionId = stringField(record, "session_id") || state.sessionId;
  state.events.push(...eventsForRecord(record, state));
}

function eventsForRecord(record: Record<string, unknown>, state: ParseState): ProviderEvent[] {
  const raw = rawEvent(record, state);
  switch (stringField(record, "type")) {
    case "system": return systemEvents(record, state, raw);
    case "assistant": return assistantEvents(record, state, raw);
    case "user": return userToolEvents(record, state, raw);
    case "result": return [resultEvent(record, state, raw)];
    case "error": return [errorEvent(record, state, raw)];
    default: return [rawSummaryEvent(record, state, raw)];
  }
}

function systemEvents(record: Record<string, unknown>, state: ParseState, raw: ProviderEvent["raw"]): ProviderEvent[] {
  if (stringField(record, "subtype") !== "init") return [rawSummaryEvent(record, state, raw)];
  const session = sessionRef(state);
  return [{
    provider: PROVIDER,
    type: "text",
    status: "started",
    session,
    raw,
    runEvent: normalizedRunEvent({
      kind: "progress",
      metadata: { provider_session_id: session.sessionId },
      method: "system.init",
      outcome: "running",
      provider: PROVIDER,
      session
    })
  }];
}

function assistantEvents(record: Record<string, unknown>, state: ParseState, raw: ProviderEvent["raw"]): ProviderEvent[] {
  return contentArray(recordField(record, "message"), "content").flatMap((item) => contentEvent(item, state, raw));
}

function contentEvent(item: Record<string, unknown>, state: ParseState, raw: ProviderEvent["raw"]): ProviderEvent[] {
  if (stringField(item, "type") === "text") return textEvent(redact(stringField(item, "text"), state), state, raw);
  if (stringField(item, "type") === "tool_use") return [toolEvent(toolCommand(item, state), state, raw)];
  return [];
}

function userToolEvents(record: Record<string, unknown>, state: ParseState, raw: ProviderEvent["raw"]): ProviderEvent[] {
  const topLevel = recordValue(record["tool_use_result"]);
  if (Object.keys(topLevel).length > 0) return textEvent(toolResultText(topLevel, state), state, raw, "tool");
  return contentArray(recordField(record, "message"), "content")
    .filter((item) => stringField(item, "type") === "tool_result")
    .flatMap((item) => textEvent(toolResultText(item, state), state, raw, "tool"));
}

function resultEvent(record: Record<string, unknown>, state: ParseState, raw: ProviderEvent["raw"]): ProviderEvent {
  state.terminal = true;
  state.turnId = stringField(record, "uuid") || state.turnId;
  const status = stringField(record, "terminal_reason") || stringField(record, "stop_reason") || "completed";
  const session = sessionRef(state);
  if (record["is_error"] === true) {
    state.error = resultError(record);
    return {
      provider: PROVIDER,
      type: "error",
      status: "failed",
      error: state.error,
      session,
      raw,
      runEvent: claudeResultRunEvent(record, session, "error", "failed")
    };
  }
  state.completed = true;
  return {
    provider: PROVIDER,
    type: "done",
    status,
    session,
    raw,
    runEvent: claudeResultRunEvent(record, session, "completed", "succeeded")
  };
}

function errorEvent(record: Record<string, unknown>, state: ParseState, raw: ProviderEvent["raw"]): ProviderEvent {
  const message = redact(errorMessage(record) || stableJSON(record), state);
  state.error = message;
  const session = sessionRef(state);
  return {
    provider: PROVIDER,
    type: "error",
    status: "failed",
    error: message,
    session,
    raw,
    runEvent: normalizedRunEvent({ kind: "error", method: "error", outcome: "failed", provider: PROVIDER, session })
  };
}

function markTransient(state: ParseState, message: string): void {
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

function textEvent(text: string, state: ParseState, raw: ProviderEvent["raw"], type = "text"): ProviderEvent[] {
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

function toolEvent(command: string, state: ParseState, raw: ProviderEvent["raw"]): ProviderEvent {
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

function rawSummaryEvent(record: Record<string, unknown>, state: ParseState, raw: ProviderEvent["raw"]): ProviderEvent {
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

function claudeResultRunEvent(
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

function rawEvent(record: Record<string, unknown>, state: ParseState): ProviderEvent["raw"] {
  return { method: stringField(record, "type") || "unknown", payload: stableJSON(redactPayload(record, state)) };
}

function sessionRef(state: ParseState): SessionRef {
  const sessionId = state.sessionId || state.runId;
  return { provider: PROVIDER, sessionId, ...(state.turnId ? { turnId: state.turnId } : {}) };
}

function initialState(options: ClaudeStreamParseOptions): ParseState {
  return { runId: options.runId, secrets: options.secrets ?? [], events: [], sessionId: "", turnId: "", terminal: false, completed: false, transient: false };
}

function streamLines(input: string): string[] {
  const lines = input.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function parseRecord(text: string): Record<string, unknown> | undefined {
  try { return recordValue(JSON.parse(text)); } catch { return undefined; }
}

function toolCommand(item: Record<string, unknown>, state: ParseState): string {
  return redact(stringField(recordField(item, "input"), "command") || stringField(item, "name"), state);
}

function toolResultText(item: Record<string, unknown>, state: ParseState): string {
  const content = item["content"];
  if (typeof content === "string") return redact(content, state);
  return redact(stringField(item, "type") || stableJSON(item), state);
}

function resultError(record: Record<string, unknown>): string {
  return stringField(record, "error") || stringField(record, "result") || stringField(record, "terminal_reason") || "Claude Code result error";
}

function errorMessage(record: Record<string, unknown>): string {
  return stringField(recordField(record, "error"), "message") || stringField(record, "message") || stringField(record, "error");
}

function redact(value: string, state: ParseState): string {
  let out = value;
  for (const secret of state.secrets) if (secret !== "") out = out.replaceAll(secret, "[redacted]");
  return redactSensitiveText(out);
}

function redactPayload(value: unknown, state: ParseState): unknown {
  if (typeof value === "string") return redact(value, state);
  if (Array.isArray(value)) return value.map((item) => redactPayload(item, state));
  const record = recordValue(value);
  if (Object.keys(record).length === 0) return value;
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, sensitiveKey(key) ? "[redacted]" : redactPayload(item, state)]));
}

function sensitiveKey(key: string): boolean {
  return /(?:token|secret|password|api[_-]?key|access[_-]?key)/i.test(key);
}

function rawSummary(method: string, payload: unknown): string {
  const body = typeof payload === "string" ? payload : stableJSON(payload);
  return body.length > RAW_LIMIT ? `${method} ${body.slice(0, RAW_LIMIT - 3)}...` : `${method} ${body}`.trim();
}

function contentArray(record: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const items = Array.isArray(record[key]) ? record[key] as unknown[] : [];
  return items.map(recordValue).filter((item) => Object.keys(item).length > 0);
}

function recordField(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  return recordValue(raw[key]);
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(raw: Record<string, unknown>, key: string): string {
  return typeof raw[key] === "string" ? raw[key].trim() : "";
}

function numericField(raw: Record<string, unknown>, key: string): number | undefined {
  const value = raw[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function usdMicros(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const micros = Math.round(value * 1_000_000);
  return Number.isSafeInteger(micros) ? micros : null;
}

function stableJSON(value: unknown): string {
  return JSON.stringify(value ?? null);
}
