import { redactSensitiveText } from "../../util/redact.ts";
import { objectValue } from "../../util/values.ts";
import { ClaudeStreamParseOptions, ParseState, RAW_LIMIT } from "./stream.ts";

export function initialState(options: ClaudeStreamParseOptions): ParseState {
  return {
    runId: options.runId,
    secrets: options.secrets ?? [],
    events: [],
    sessionId: options.sessionId?.trim() ?? "",
    turnId: "",
    terminal: false,
    completed: false,
    transient: false
  };
}

export function streamLines(input: string): string[] {
  const lines = input.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function parseRecord(text: string): Record<string, unknown> | undefined {
  try { return objectValue(JSON.parse(text)); } catch { return undefined; }
}

export function toolCommand(item: Record<string, unknown>, state: ParseState): string {
  return redact(stringField(recordField(item, "input"), "command") || stringField(item, "name"), state);
}

export function toolResultText(item: Record<string, unknown>, state: ParseState): string {
  const content = item["content"];
  if (typeof content === "string") return redact(content, state);
  return redact(stringField(item, "type") || stableJSON(item), state);
}

export function resultError(record: Record<string, unknown>): string {
  return stringField(record, "error") || stringField(record, "result") || stringField(record, "terminal_reason") || "Claude Code result error";
}

export function errorMessage(record: Record<string, unknown>): string {
  return stringField(recordField(record, "error"), "message") || stringField(record, "message") || stringField(record, "error");
}

export function redact(value: string, state: ParseState): string {
  let out = value;
  for (const secret of state.secrets) if (secret !== "") out = out.replaceAll(secret, "[redacted]");
  return redactSensitiveText(out);
}

export function redactPayload(value: unknown, state: ParseState): unknown {
  if (typeof value === "string") return redact(value, state);
  if (Array.isArray(value)) return value.map((item) => redactPayload(item, state));
  const record = objectValue(value);
  if (Object.keys(record).length === 0) return value;
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, sensitiveKey(key) ? "[redacted]" : redactPayload(item, state)]));
}

export function sensitiveKey(key: string): boolean {
  return /(?:token|secret|password|api[_-]?key|access[_-]?key)/i.test(key);
}

export function rawSummary(method: string, payload: unknown): string {
  const body = typeof payload === "string" ? payload : stableJSON(payload);
  return body.length > RAW_LIMIT ? `${method} ${body.slice(0, RAW_LIMIT - 3)}...` : `${method} ${body}`.trim();
}

export function contentArray(record: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const items = Array.isArray(record[key]) ? record[key] as unknown[] : [];
  return items.map(objectValue).filter((item) => Object.keys(item).length > 0);
}

export function recordField(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  return objectValue(raw[key]);
}

export function stringField(raw: Record<string, unknown>, key: string): string {
  return typeof raw[key] === "string" ? raw[key].trim() : "";
}

export function numericField(raw: Record<string, unknown>, key: string): number | undefined {
  const value = raw[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function usdMicros(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const micros = Math.round(value * 1_000_000);
  return Number.isSafeInteger(micros) ? micros : null;
}

export function stableJSON(value: unknown): string {
  return JSON.stringify(value ?? null);
}
