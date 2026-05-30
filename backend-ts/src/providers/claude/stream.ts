import { redactSensitiveText } from "../../util/redact.ts";
import type { ProviderEvent, SessionRef } from "../types.ts";

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
  return [{ provider: PROVIDER, type: "text", status: "started", session: sessionRef(state), raw }];
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
  if (record["is_error"] === true) {
    state.error = resultError(record);
    return { provider: PROVIDER, type: "error", status: "failed", error: state.error, session: sessionRef(state), raw };
  }
  state.completed = true;
  return { provider: PROVIDER, type: "done", status, session: sessionRef(state), raw };
}

function errorEvent(record: Record<string, unknown>, state: ParseState, raw: ProviderEvent["raw"]): ProviderEvent {
  const message = redact(errorMessage(record) || stableJSON(record), state);
  state.error = message;
  return { provider: PROVIDER, type: "error", status: "failed", error: message, session: sessionRef(state), raw };
}

function markTransient(state: ParseState, message: string): void {
  state.transient = true;
  state.diagnostic = message;
  state.error = message;
  state.events.push({ provider: PROVIDER, type: "error", status: "transient", error: message, session: sessionRef(state) });
}

function textEvent(text: string, state: ParseState, raw: ProviderEvent["raw"], type = "text"): ProviderEvent[] {
  return text === "" ? [] : [{ provider: PROVIDER, type, text, session: sessionRef(state), raw }];
}

function toolEvent(command: string, state: ParseState, raw: ProviderEvent["raw"]): ProviderEvent {
  return { provider: PROVIDER, type: "tool", command, session: sessionRef(state), raw };
}

function rawSummaryEvent(record: Record<string, unknown>, state: ParseState, raw: ProviderEvent["raw"]): ProviderEvent {
  const payload = rawSummary(stringField(record, "type") || "unknown", raw?.payload ?? "");
  return { provider: PROVIDER, type: "raw", payload, session: sessionRef(state), raw };
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

function stableJSON(value: unknown): string {
  return JSON.stringify(value ?? null);
}
