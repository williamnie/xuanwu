import type { ProviderEvent } from "../providers/types.ts";
import type { PiSupervisorDiagnosisCode } from "./issueSupervisorRecovery.ts";
import {
  asRecord,
  durationTime,
  epochTime,
  naturalRetryTime,
  normalizeKey,
  parseJsonMaybe,
  parseJsonObject,
  parseResetTime,
  parseRetryTime,
  parseStatusCode,
  redactedProviderErrorSummary,
  secondsUntil,
  SENSITIVE_KEY_PATTERN,
  statusCodeFromText
} from "./providerErrorParserSupport.ts";

export const PROVIDER_ERROR_CATEGORIES = [
  "stream_disconnect",
  "rate_limit",
  "network",
  "auth",
  "permission",
  "quota",
  "business_failure",
  "unknown"
] as const;

export type ProviderErrorCategory = typeof PROVIDER_ERROR_CATEGORIES[number];
export type ProviderErrorParserOptions = { now?: Date };

export type ProviderErrorParserInput = {
  headers?: Record<string, unknown>;
  issueEventPayload?: unknown;
  providerEvent?: Partial<ProviderEvent>;
  providerHealth?: unknown;
  rawPayload?: unknown;
};

export type ProviderErrorSignal = {
  category: ProviderErrorCategory;
  diagnosis_code?: PiSupervisorDiagnosisCode;
  limit_id?: string;
  limit_name?: string;
  model?: string;
  observed_at?: string;
  provider?: string;
  rate_limit_reset_at?: string;
  raw_summary: string;
  retry_after_at?: string;
  retry_after_seconds?: number;
  service_tier?: string;
  status_code?: number;
};

type ParseState = {
  limitID?: string;
  limitName?: string;
  model?: string;
  now: Date;
  provider?: string;
  rateLimitHint: boolean;
  rateLimitResetAt?: string;
  retryAfterAt?: string;
  statusCode?: number;
  serviceTier?: string;
  texts: string[];
};

export function parseProviderErrorSignal(
  input: ProviderErrorParserInput,
  options: ProviderErrorParserOptions = {}
): ProviderErrorSignal {
  const state = newState(options.now);
  collectInput(input, state);
  const category = classify(state);
  return compactSignal({
    category,
    diagnosis_code: diagnosisCode(category, state),
    limit_id: state.limitID,
    limit_name: state.limitName,
    model: state.model,
    provider: state.provider,
    rate_limit_reset_at: state.rateLimitResetAt,
    raw_summary: redactedProviderErrorSummary(state.texts, state.statusCode),
    retry_after_at: state.retryAfterAt,
    retry_after_seconds: secondsUntil(state.retryAfterAt, state.now),
    service_tier: state.serviceTier,
    status_code: state.statusCode
  });
}

export function parseIssueEventProviderError(
  payload: unknown,
  options: ProviderErrorParserOptions = {}
): ProviderErrorSignal {
  return parseProviderErrorSignal({ issueEventPayload: payload }, options);
}

export function parseProviderEventError(
  event: Partial<ProviderEvent>,
  options: ProviderErrorParserOptions = {}
): ProviderErrorSignal {
  return parseProviderErrorSignal({ providerEvent: event }, options);
}

export function parseProviderHealthSignal(
  snapshot: unknown,
  options: ProviderErrorParserOptions = {}
): ProviderErrorSignal {
  return parseProviderErrorSignal({ providerHealth: snapshot }, options);
}

function collectInput(input: ProviderErrorParserInput, state: ParseState): void {
  collectValue({ value: input.headers, state, key: "headers" });
  collectValue({ value: input.rawPayload, state, key: "raw_payload" });
  collectIssueEventPayload(input.issueEventPayload, state);
  collectProviderEvent(input.providerEvent, state);
  collectValue({ value: input.providerHealth, state, key: "provider_health" });
}

function collectIssueEventPayload(payload: unknown, state: ParseState): void {
  const value = parseJsonMaybe(payload);
  const record = asRecord(value);
  if (!shouldInspectIssueEventPayload(record)) return;
  collectIssueEventEnvelope(record, state);
  collectValue({ value: record.error, state, key: "error" });
  if (explicitErrorIssueEvent(record)) collectValue({ value: record.text, state, key: "text" });
  // Watchdog boundary: never recursively scan completed command/source/test output inside issue logs.
  // Only explicit error text and structured provider diagnostic fields may become provider-error signals.
  collectIssueEventDiagnosticField(record.payload, state, "payload", explicitErrorIssueEvent(record));
  collectIssueEventDiagnosticField(record.raw_payload, state, "raw_payload", explicitErrorIssueEvent(record));
}

function shouldInspectIssueEventPayload(record: Record<string, unknown>): boolean {
  const type = cleanLower(record.type);
  const status = cleanLower(record.status);
  const rawMethod = cleanLower(record.raw_method);
  if (type === "error") return true;
  if (rawMethod === "turn/completed" && status !== "" && status !== "completed") return true;
  if (status === "failed" || status === "error") return true;
  if (status === "completed") return false;
  if (hasStructuredProviderError(record)) return true;
  const rawPayload = parseJsonMaybe(record.raw_payload);
  return hasStructuredProviderError(asRecord(rawPayload));
}

function hasStructuredProviderError(record: Record<string, unknown>): boolean {
  return Object.keys(record).some((key) => (
    /^(status_code|statuscode|http_status|retry_after|retry_after_ms|retryafter|retryafterms|retry_after_at|retryafterat)$/i.test(key)
  )) || cleanString(record.error) !== "" && (
    cleanString(record.provider) !== "" || cleanString(record.code) !== "" || cleanString(record.kind) !== ""
  );
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanLower(value: unknown): string {
  return cleanString(value).toLowerCase();
}

function explicitErrorIssueEvent(record: Record<string, unknown>): boolean {
  return cleanLower(record.type) === "error" || cleanLower(record.status) === "error" || cleanLower(record.status) === "failed";
}

function collectIssueEventEnvelope(record: Record<string, unknown>, state: ParseState): void {
  for (const key of ["provider", "model", "service_tier", "limit_id", "limit_name", "status_code", "http_status", "code", "kind"]) {
    collectValue({ value: record[key], state, key });
  }
}

function collectIssueEventDiagnosticField(value: unknown, state: ParseState, key: string, allowText: boolean): void {
  const parsed = parseJsonMaybe(value);
  if (typeof parsed === "string") {
    if (allowText) collectValue({ value: parsed, state, key });
    return;
  }
  const out: Record<string, unknown> = {};
  for (const [rawKey, item] of Object.entries(asRecord(parsed))) {
    if (isProviderErrorField(normalizeKey(rawKey))) out[rawKey] = item;
  }
  if (Object.keys(out).length > 0) collectValue({ value: out, state, key });
}

function isProviderErrorField(value: string): boolean {
  return /^(?:status|statuscode|httpstatus|httpstatuscode|code|kind|error|message|retryafter|retryafterms|retryafterat|ratelimited|ratelimitreset|ratelimitresetat|retryat|resetat|resetsat|resetsatiso|provider|model|servicetier|limitid|limitname)$/.test(value);
}

function collectProviderEvent(event: Partial<ProviderEvent> | undefined, state: ParseState): void {
  if (!event) return;
  if (!shouldInspectProviderEvent(event)) return;
  if (event.provider) state.provider = event.provider;
  collectValue({ value: event.error, state, key: "error" });
  collectValue({ value: event.text, state, key: "text" });
  collectValue({ value: event.payload, state, key: "payload" });
  collectValue({ value: event.raw?.payload, state, key: "raw_payload" });
  collectValue({ value: event.raw?.method, state, key: "raw_method" });
}

function shouldInspectProviderEvent(event: Partial<ProviderEvent>): boolean {
  const status = cleanLower(event.status);
  if (cleanLower(event.type) === "error") return true;
  if (status === "completed") return false;
  if (cleanLower(event.raw?.method) === "turn/completed" && status !== "") return true;
  return status === "failed" || status === "error";
}

type CollectValueInput = { depth?: number; key?: string; state: ParseState; value: unknown };

function collectValue(input: CollectValueInput): void {
  const { value, state, key = "", depth = 0 } = input;
  if (value === undefined || value === null || depth > 6) return;
  if (typeof value === "string") return collectString({ value, state, key, depth });
  if (typeof value === "number") return applyNumericField(key, value, state);
  if (typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 25)) collectValue({ value: item, state, key, depth: depth + 1 });
    return;
  }
  for (const [rawKey, item] of Object.entries(value as Record<string, unknown>)) {
    applyField(rawKey, item, state);
    if (!SENSITIVE_KEY_PATTERN.test(rawKey)) {
      collectValue({ value: item, state, key: rawKey, depth: depth + 1 });
    }
  }
}

function collectString(input: Required<CollectValueInput>): void {
  const { value, state, key, depth } = input;
  const text = String(value).trim();
  if (text === "") return;
  state.texts.push(text);
  state.statusCode = statusCodeFromText(text) ?? state.statusCode;
  applyStringField(key, text, state);
  const parsed = parseJsonObject(text);
  if (parsed) collectValue({ value: parsed, state, key, depth: depth + 1 });
}

function applyField(key: string, value: unknown, state: ParseState): void {
  const normalized = normalizeKey(key);
  if (typeof value === "string") applyStringField(normalized, value, state);
  if (typeof value === "number") applyNumericField(normalized, value, state);
  if (typeof value === "boolean" && /rate.?limited|rate.?limit/.test(normalized) && value) {
    state.rateLimitHint = true;
  }
}

function applyStringField(key: string, value: string, state: ParseState): void {
  const normalized = normalizeKey(key);
  const text = value.trim();
  if (text === "") return;
  if (isStatusKey(normalized)) state.statusCode = parseStatusCode(text) ?? state.statusCode;
  if (normalized === "retryafter" || normalized === "retryafterat") {
    setRetryAfter(state, parseRetryTime(text, state.now));
  }
  if (normalized === "retryafterms") setRetryAfter(state, durationTime(Number(text), "ms", state.now));
  if (isResetKey(normalized)) setRateLimitReset(state, parseResetTime(text, state.now));
  if (normalized === "provider") state.provider = text;
  if (normalized === "model") state.model = text;
  if (normalized === "servicetier") state.serviceTier = text;
  if (normalized === "limitid") state.limitID = text;
  if (normalized === "limitname") state.limitName = text;
  setRetryAfter(state, naturalRetryTime(text, state.now));
}

function applyNumericField(key: string, value: number, state: ParseState): void {
  const normalized = normalizeKey(key);
  if (isStatusKey(normalized)) state.statusCode = parseStatusCode(value) ?? state.statusCode;
  if (normalized === "retryafter") setRetryAfter(state, durationTime(value, "s", state.now));
  if (normalized === "retryafterms") setRetryAfter(state, durationTime(value, "ms", state.now));
  if (isResetKey(normalized)) setRateLimitReset(state, epochTime(value));
  if (/remainingpercent|remaining/.test(normalized) && value <= 0) state.rateLimitHint = true;
}

function classify(state: ParseState): ProviderErrorCategory {
  const text = allText(state);
  if (state.statusCode === 401 || /\bunauthorized\b|authentication failed|invalid api key/.test(text)) return "auth";
  if (state.statusCode === 403 || /permission denied|forbidden|access denied|approval denied/.test(text)) {
    return "permission";
  }
  if (state.statusCode === 429 || state.rateLimitHint || hasRateLimitText(text)) return "rate_limit";
  if (/quota (?:exceeded|exhausted)|insufficient quota|usage limit/.test(text)) return "quota";
  if (/reconnecting\.\.\.|\bresponsestreamdisconnected\b|stream disconnected/.test(text)) return "stream_disconnect";
  if (/network error|fetch failed|connection reset|econnreset|etimedout|socket hang up/.test(text)) return "network";
  if (/unexpected eof|\beof\b|body decode|decoding response body|timeout|timed out|dns/.test(text)) return "network";
  if (/verification failed|tests? failed|business failure|validation failed|exit status|command failed/.test(text)) {
    return "business_failure";
  }
  return "unknown";
}

function hasRateLimitText(value: string): boolean {
  return /rate limit|too many requests|quota temporarily unavailable/.test(value);
}

function diagnosisCode(category: ProviderErrorCategory, state: ParseState): PiSupervisorDiagnosisCode | undefined {
  if (category === "stream_disconnect") return "executor_stream_disconnected";
  if (category === "network") return "provider_transient_network_error";
  if (category === "rate_limit" && state.retryAfterAt) return retryWindowCode(state.retryAfterAt, state.now);
  if (category === "rate_limit") return "provider_rate_limited";
  if (category === "auth" || category === "permission" || category === "quota" || category === "business_failure") {
    return "requires_human_decision";
  }
  return undefined;
}

function retryWindowCode(value: string, now: Date): PiSupervisorDiagnosisCode {
  return Date.parse(value) > now.getTime() ? "provider_retry_after_waiting" : "provider_retry_after_ready";
}

function setRetryAfter(state: ParseState, value: string | undefined): void {
  if (value && !state.retryAfterAt) state.retryAfterAt = value;
}

function setRateLimitReset(state: ParseState, value: string | undefined): void {
  if (!value) return;
  if (!state.rateLimitResetAt) state.rateLimitResetAt = value;
  setRetryAfter(state, value);
}

function compactSignal(signal: ProviderErrorSignal): ProviderErrorSignal {
  const entries = Object.entries(signal).filter(([, value]) => value !== undefined && value !== "");
  return Object.fromEntries(entries) as ProviderErrorSignal;
}

function allText(state: ParseState): string {
  const parts = [state.statusCode ? `status ${state.statusCode}` : "", ...state.texts];
  return parts.join(" ").toLowerCase();
}

function isStatusKey(value: string): boolean {
  return /^(?:status|statuscode|httpstatus|httpstatuscode|code)$/.test(value);
}

function isResetKey(value: string): boolean {
  return /^(?:resetat|ratelimitreset|ratelimitresetat|retryat|resetsat|resetsatiso)$/.test(value);
}

function newState(now: Date | undefined): ParseState {
  return { now: now ?? new Date(), rateLimitHint: false, texts: [] };
}
