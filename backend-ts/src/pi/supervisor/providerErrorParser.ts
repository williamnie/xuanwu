import type { ProviderEvent } from "../../providers/types.ts";
import type { PiSupervisorDiagnosisCode } from "./issueSupervisorRecovery.ts";
import { asRecord, normalizeKey, parseJsonMaybe, redactedProviderErrorSummary, secondsUntil } from "./providerErrorParserSupport.ts";
import { cleanString } from "../../util/values.ts";
import { newState, classify, compactSignal, diagnosisCode, collectValue } from "./providerErrorFields.ts";

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
  source_event_type?: string;
  status_code?: number;
};

export type ParseState = {
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

export function collectInput(input: ProviderErrorParserInput, state: ParseState): void {
  collectValue({ value: input.headers, state, key: "headers" });
  collectValue({ value: input.rawPayload, state, key: "raw_payload" });
  collectIssueEventPayload(input.issueEventPayload, state);
  collectProviderEvent(input.providerEvent, state);
  collectValue({ value: input.providerHealth, state, key: "provider_health" });
}

export function collectIssueEventPayload(payload: unknown, state: ParseState): void {
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

export function shouldInspectIssueEventPayload(record: Record<string, unknown>): boolean {
  const type = cleanLower(record.type);
  const status = cleanLower(record.status);
  const rawMethod = cleanLower(record.raw_method);
  if (type === "error") return true;
  if (nonTerminalWorkItemIssueEvent(type, rawMethod)) return false;
  if (rawMethod === "turn/completed" && status !== "" && status !== "completed") return true;
  if (status === "failed" || status === "error") return true;
  if (status === "completed") return false;
  if (hasStructuredProviderError(record)) return true;
  const rawPayload = parseJsonMaybe(record.raw_payload);
  return hasStructuredProviderError(asRecord(rawPayload));
}

export function nonTerminalWorkItemIssueEvent(type: string, rawMethod: string): boolean {
  return type === "tool" || rawMethod.startsWith("item/");
}

export function hasStructuredProviderError(record: Record<string, unknown>): boolean {
  return Object.keys(record).some((key) => (
    /^(status_code|statuscode|http_status|retry_after|retry_after_ms|retryafter|retryafterms|retry_after_at|retryafterat)$/i.test(key)
  )) || cleanString(record.error) !== "" && (
    cleanString(record.provider) !== "" || cleanString(record.code) !== "" || cleanString(record.kind) !== ""
  );
}

export function cleanLower(value: unknown): string {
  return cleanString(value).toLowerCase();
}

export function explicitErrorIssueEvent(record: Record<string, unknown>): boolean {
  return cleanLower(record.type) === "error" || cleanLower(record.status) === "error" || cleanLower(record.status) === "failed";
}

export function collectIssueEventEnvelope(record: Record<string, unknown>, state: ParseState): void {
  for (const key of ["provider", "model", "service_tier", "limit_id", "limit_name", "status_code", "http_status", "code", "kind"]) {
    collectValue({ value: record[key], state, key });
  }
}

export function collectIssueEventDiagnosticField(value: unknown, state: ParseState, key: string, allowText: boolean): void {
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

export function isProviderErrorField(value: string): boolean {
  return /^(?:status|statuscode|httpstatus|httpstatuscode|code|kind|error|message|retryafter|retryafterms|retryafterat|ratelimited|ratelimitreset|ratelimitresetat|retryat|resetat|resetsat|resetsatiso|provider|model|servicetier|limitid|limitname)$/.test(value);
}

export function collectProviderEvent(event: Partial<ProviderEvent> | undefined, state: ParseState): void {
  if (!event) return;
  if (!shouldInspectProviderEvent(event)) return;
  if (event.provider) state.provider = event.provider;
  collectValue({ value: event.error, state, key: "error" });
  collectValue({ value: event.text, state, key: "text" });
  collectValue({ value: event.payload, state, key: "payload" });
  collectValue({ value: event.raw?.payload, state, key: "raw_payload" });
  collectValue({ value: event.raw?.method, state, key: "raw_method" });
}

export function shouldInspectProviderEvent(event: Partial<ProviderEvent>): boolean {
  const status = cleanLower(event.status);
  const type = cleanLower(event.type);
  const method = cleanLower(event.raw?.method);
  if (type === "error") return true;
  if (nonTerminalWorkItemProviderEvent(type, method)) return false;
  if (status === "completed") return false;
  if (method === "turn/completed" && status !== "") return true;
  return status === "failed" || status === "error";
}

export function nonTerminalWorkItemProviderEvent(type: string, method: string): boolean {
  return type === "tool" || method.startsWith("item/");
}
