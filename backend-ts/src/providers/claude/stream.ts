import { normalizedRunEvent } from "../runEvents.ts";
import type { ProviderEvent, SessionRef } from "../types.ts";
import { objectValue } from "../../util/values.ts";
import { markTransient, sessionRef, rawSummaryEvent, rawEvent, textEvent, toolEvent, claudeResultRunEvent } from "./streamEvents.ts";
import { initialState, streamLines, parseRecord, redact, stringField, contentArray, recordField, toolCommand, toolResultText, resultError, errorMessage, stableJSON } from "./streamValues.ts";

export const PROVIDER = "claude";

export const RAW_LIMIT = 240;

export type ClaudeStreamParseOptions = { runId: string; secrets?: string[]; sessionId?: string };

export type ClaudeStreamParseResult = {
  completed: boolean;
  diagnostic?: string;
  error?: string;
  events: ProviderEvent[];
  session?: SessionRef;
  transient: boolean;
};

export type ParseState = Required<Pick<ClaudeStreamParseOptions, "runId">> & {
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

export function parseLine(line: string, index: number, state: ParseState, canBeTruncated: boolean): void {
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

export function eventsForRecord(record: Record<string, unknown>, state: ParseState): ProviderEvent[] {
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

export function systemEvents(record: Record<string, unknown>, state: ParseState, raw: ProviderEvent["raw"]): ProviderEvent[] {
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

export function assistantEvents(record: Record<string, unknown>, state: ParseState, raw: ProviderEvent["raw"]): ProviderEvent[] {
  return contentArray(recordField(record, "message"), "content").flatMap((item) => contentEvent(item, state, raw));
}

export function contentEvent(item: Record<string, unknown>, state: ParseState, raw: ProviderEvent["raw"]): ProviderEvent[] {
  if (stringField(item, "type") === "text") return textEvent(redact(stringField(item, "text"), state), state, raw);
  if (stringField(item, "type") === "tool_use") return [toolEvent(toolCommand(item, state), state, raw)];
  return [];
}

export function userToolEvents(record: Record<string, unknown>, state: ParseState, raw: ProviderEvent["raw"]): ProviderEvent[] {
  const topLevel = objectValue(record["tool_use_result"]);
  if (Object.keys(topLevel).length > 0) return textEvent(toolResultText(topLevel, state), state, raw, "tool");
  return contentArray(recordField(record, "message"), "content")
    .filter((item) => stringField(item, "type") === "tool_result")
    .flatMap((item) => textEvent(toolResultText(item, state), state, raw, "tool"));
}

export function resultEvent(record: Record<string, unknown>, state: ParseState, raw: ProviderEvent["raw"]): ProviderEvent {
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

export function errorEvent(record: Record<string, unknown>, state: ParseState, raw: ProviderEvent["raw"]): ProviderEvent {
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
