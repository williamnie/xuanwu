import type { PiSupervisorDiagnosisCode } from "./issueSupervisorRecovery.ts";
import { durationTime, epochTime, naturalRetryTime, normalizeKey, parseJsonObject, parseResetTime, parseRetryTime, parseStatusCode, SENSITIVE_KEY_PATTERN, statusCodeFromText } from "./providerErrorParserSupport.ts";
import { ParseState, type ProviderErrorCategory, type ProviderErrorSignal } from "./providerErrorParser.ts";

export type CollectValueInput = { depth?: number; key?: string; state: ParseState; value: unknown };

export function collectValue(input: CollectValueInput): void {
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

export function collectString(input: Required<CollectValueInput>): void {
  const { value, state, key, depth } = input;
  const text = String(value).trim();
  if (text === "") return;
  state.texts.push(text);
  state.statusCode = statusCodeFromText(text) ?? state.statusCode;
  applyStringField(key, text, state);
  const parsed = parseJsonObject(text);
  if (parsed) collectValue({ value: parsed, state, key, depth: depth + 1 });
}

export function applyField(key: string, value: unknown, state: ParseState): void {
  const normalized = normalizeKey(key);
  if (typeof value === "string") applyStringField(normalized, value, state);
  if (typeof value === "number") applyNumericField(normalized, value, state);
  if (typeof value === "boolean" && /rate.?limited|rate.?limit/.test(normalized) && value) {
    state.rateLimitHint = true;
  }
}

export function applyStringField(key: string, value: string, state: ParseState): void {
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

export function applyNumericField(key: string, value: number, state: ParseState): void {
  const normalized = normalizeKey(key);
  if (isStatusKey(normalized)) state.statusCode = parseStatusCode(value) ?? state.statusCode;
  if (normalized === "retryafter") setRetryAfter(state, durationTime(value, "s", state.now));
  if (normalized === "retryafterms") setRetryAfter(state, durationTime(value, "ms", state.now));
  if (isResetKey(normalized)) setRateLimitReset(state, epochTime(value));
  if (/remainingpercent|remaining/.test(normalized) && value <= 0) state.rateLimitHint = true;
}

export function classify(state: ParseState): ProviderErrorCategory {
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

export function hasRateLimitText(value: string): boolean {
  return /rate limit|too many requests|quota temporarily unavailable|at capacity|server ?overloaded|serveroverloaded|overloaded/.test(value);
}

export function diagnosisCode(category: ProviderErrorCategory, state: ParseState): PiSupervisorDiagnosisCode | undefined {
  if (category === "stream_disconnect") return "executor_stream_disconnected";
  if (category === "network") return "provider_transient_network_error";
  if (category === "rate_limit" && state.retryAfterAt) return retryWindowCode(state.retryAfterAt, state.now);
  if (category === "rate_limit") return "provider_rate_limited";
  if (category === "auth" || category === "permission" || category === "quota" || category === "business_failure") {
    return "requires_human_decision";
  }
  return undefined;
}

export function retryWindowCode(value: string, now: Date): PiSupervisorDiagnosisCode {
  return Date.parse(value) > now.getTime() ? "provider_retry_after_waiting" : "provider_retry_after_ready";
}

export function setRetryAfter(state: ParseState, value: string | undefined): void {
  if (value && !state.retryAfterAt) state.retryAfterAt = value;
}

export function setRateLimitReset(state: ParseState, value: string | undefined): void {
  if (!value) return;
  if (!state.rateLimitResetAt) state.rateLimitResetAt = value;
  setRetryAfter(state, value);
}

export function compactSignal(signal: ProviderErrorSignal): ProviderErrorSignal {
  const entries = Object.entries(signal).filter(([, value]) => value !== undefined && value !== "");
  return Object.fromEntries(entries) as ProviderErrorSignal;
}

export function allText(state: ParseState): string {
  const parts = [state.statusCode ? `status ${state.statusCode}` : "", ...state.texts];
  return parts.join(" ").toLowerCase();
}

export function isStatusKey(value: string): boolean {
  return /^(?:status|statuscode|httpstatus|httpstatuscode|code)$/.test(value);
}

export function isResetKey(value: string): boolean {
  return /^(?:resetat|ratelimitreset|ratelimitresetat|retryat|resetsat|resetsatiso)$/.test(value);
}

export function newState(now: Date | undefined): ParseState {
  return { now: now ?? new Date(), rateLimitHint: false, texts: [] };
}
