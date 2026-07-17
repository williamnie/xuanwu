import { createHash } from "node:crypto";
import { HTTP_READONLY_PROVIDER_ID, URL_FETCH_TOOL_NAME } from "./httpToolProvider.ts";
import type { ToolResult, ToolResultError } from "./toolProviderEnvelope.ts";
import { unsafeUrlEgressReason } from "../security/promptInjectionDefense.ts";

export type HttpToolCallInput = {
  input?: Record<string, unknown>;
  invocationID?: string;
  timeoutMs?: number;
  toolName: string;
};
type Clock = { invocationID: string; started: number; startedAt: Date };
type FetchOptions = {
  allowTypes: string[];
  denyTypes: string[];
  extractText: boolean;
  maxBytes: number;
  maxRedirects: number;
  method: "GET" | "HEAD";
  timeoutMs: number;
  url: string;
};
type RedirectHop = { from_url: string; location: string; status: number; to_url: string };
type FetchOutcome = { finalUrl: string; redirects: RedirectHop[]; response: Response };
type BodyExcerpt = { bytes: Uint8Array; truncated: boolean };
const DEFAULT_MAX_BYTES = 65_536;
const MAX_BYTES = 262_144;
const DEFAULT_MAX_REDIRECTS = 3;
const MAX_REDIRECTS = 10;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export async function callHttpTool(request: HttpToolCallInput): Promise<ToolResult> {
  const clock = invocationClock(request.invocationID);
  if (request.toolName !== URL_FETCH_TOOL_NAME) {
    return finish(clock, "failed", { code: "http_tool_not_found", message: `HTTP tool not found: ${request.toolName}` });
  }
  const parsed = parseFetchOptions(request.input ?? {}, request.timeoutMs);
  if ("error" in parsed) return finish(clock, parsed.status, parsed.error);
  return await executeFetch(clock, parsed);
}
async function executeFetch(clock: Clock, options: FetchOptions): Promise<ToolResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const outcome = await fetchWithRedirects(options, controller.signal);
    const contentType = outcome.response.headers.get("content-type") ?? "";
    const typeDecision = contentTypeDecision(contentType, options);
    if (!typeDecision.allowed) return deniedContentType(clock, options, outcome, contentType, typeDecision.reason);
    const body = await readBody(outcome.response, options);
    return finish(clock, "succeeded", undefined, outputFromBody(options, outcome, contentType, body), metadata(options));
  } catch (error) {
    return fetchError(clock, error);
  } finally {
    clearTimeout(timer);
  }
}
async function fetchWithRedirects(options: FetchOptions, signal: AbortSignal): Promise<FetchOutcome> {
  const redirects: RedirectHop[] = [];
  let current = options.url;
  for (;;) {
    const response = await fetch(current, { method: options.method, redirect: "manual", signal });
    if (!REDIRECT_STATUSES.has(response.status)) return { finalUrl: current, redirects, response };
    const location = response.headers.get("location") ?? "";
    if (location === "") return { finalUrl: current, redirects, response };
    const next = new URL(location, current).toString();
    redirects.push({ from_url: current, location, status: response.status, to_url: next });
    await response.body?.cancel();
    if (redirects.length > options.maxRedirects) throw redirectLimitError(options.maxRedirects);
    current = next;
  }
}
async function readBody(response: Response, options: FetchOptions): Promise<BodyExcerpt> {
  if (options.method === "HEAD" || !response.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return { bytes: concatBytes(chunks, total), truncated: false };
    const value = chunk.value;
    const remaining = options.maxBytes - total;
    if (value.byteLength > remaining) {
      if (remaining > 0) chunks.push(value.slice(0, remaining));
      await reader.cancel();
      return { bytes: concatBytes(chunks, options.maxBytes), truncated: true };
    }
    chunks.push(value);
    total += value.byteLength;
  }
}
function outputFromBody(
  options: FetchOptions,
  outcome: FetchOutcome,
  contentType: string,
  body: BodyExcerpt
): Record<string, unknown> {
  const hash = `sha256:${createHash("sha256").update(body.bytes).digest("hex")}`;
  const text = shouldExtractText(contentType, options) ? extractText(body.bytes, contentType) : "";
  return {
    bytes_read: body.bytes.byteLength,
    content_type: contentType,
    evidence_ref: `url_fetch:${hash}`,
    final_url: outcome.finalUrl,
    hash,
    hash_scope: "body_excerpt",
    max_bytes: options.maxBytes,
    ok: outcome.response.ok,
    redirect_count: outcome.redirects.length,
    redirects: outcome.redirects,
    status: outcome.response.status,
    text,
    text_extracted: text !== "",
    truncated: body.truncated,
    url: options.url
  };
}
function parseFetchOptions(
  input: Record<string, unknown>,
  timeoutMs: number | undefined
): FetchOptions | { error: ToolResultError; status: "denied" | "failed" } {
  const method = cleanString(input.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return { error: { code: "method_not_allowed", message: "url_fetch only supports GET and HEAD" }, status: "denied" };
  }
  const url = normalizedUrl(input.url);
  if ("error" in url) return url;
  return {
    allowTypes: stringList(input.allow_content_types ?? input.allowContentTypes),
    denyTypes: stringList(input.deny_content_types ?? input.denyContentTypes),
    extractText: input.extract_text !== false && input.extractText !== false,
    maxBytes: boundedInt(input.max_bytes ?? input.maxBytes, DEFAULT_MAX_BYTES, MAX_BYTES),
    maxRedirects: boundedInt(input.max_redirects ?? input.maxRedirects, DEFAULT_MAX_REDIRECTS, MAX_REDIRECTS),
    method,
    timeoutMs: boundedInt(input.timeout_ms ?? input.timeoutMs ?? timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
    url: url.value
  };
}
function normalizedUrl(value: unknown): { value: string } | { error: ToolResultError; status: "denied" | "failed" } {
  try {
    const url = new URL(cleanString(value));
    if (url.protocol === "http:" || url.protocol === "https:") {
      const unsafeReason = unsafeUrlEgressReason(url);
      if (unsafeReason !== "") {
        return { error: { code: "sensitive_url_denied", message: unsafeReason }, status: "denied" };
      }
      return { value: url.toString() };
    }
    return { error: { code: "url_scheme_denied", message: "url_fetch only supports http and https URLs" }, status: "denied" };
  } catch {
    return { error: { code: "invalid_url", message: "url_fetch requires a valid URL" }, status: "failed" };
  }
}
function deniedContentType(
  clock: Clock,
  options: FetchOptions,
  outcome: FetchOutcome,
  contentType: string,
  reason: string
): ToolResult {
  return finish(clock, "denied", {
    code: "content_type_denied",
    details: { content_type: contentType, final_url: outcome.finalUrl, status: outcome.response.status, url: options.url },
    message: reason
  }, undefined, metadata(options));
}
function fetchError(clock: Clock, error: unknown): ToolResult {
  if (isAbortError(error)) return finish(clock, "timeout", { code: "http_timeout", message: "HTTP fetch timed out" });
  if (isRedirectLimitError(error)) return finish(clock, "failed", { code: "http_redirect_limit", message: error.message });
  return finish(clock, "failed", { code: "http_fetch_error", message: errorMessage(error) });
}
function contentTypeDecision(contentType: string, options: FetchOptions): { allowed: boolean; reason: string } {
  if (matchesAnyType(contentType, options.denyTypes)) return { allowed: false, reason: `content-type denied: ${contentType}` };
  if (options.allowTypes.length > 0 && !matchesAnyType(contentType, options.allowTypes)) {
    return { allowed: false, reason: `content-type not allowed: ${contentType}` };
  }
  return { allowed: true, reason: "" };
}
function matchesAnyType(contentType: string, patterns: string[]): boolean {
  const type = mediaType(contentType);
  return patterns.some((pattern) => typeMatches(type, mediaType(pattern)));
}
function typeMatches(type: string, pattern: string): boolean {
  if (pattern === "" || type === "") return false;
  if (pattern === "*" || pattern === "*/*") return true;
  if (pattern.endsWith("/*")) return type.startsWith(pattern.slice(0, -1));
  return type === pattern;
}
function shouldExtractText(contentType: string, options: FetchOptions): boolean {
  return options.extractText && (contentType.trim() === "" || isTextMediaType(contentType));
}
function isTextMediaType(contentType: string): boolean {
  const type = mediaType(contentType);
  return type.startsWith("text/") || type.endsWith("+json") || type.endsWith("+xml") ||
    ["application/json", "application/javascript", "application/x-ndjson", "application/xml"].includes(type);
}
function extractText(bytes: Uint8Array, contentType: string): string {
  const decoded = decodeBytes(bytes, contentType);
  return mediaType(contentType) === "text/html" ? htmlToText(decoded) : decoded;
}
function decodeBytes(bytes: Uint8Array, _contentType: string): string {
  return new TextDecoder("utf-8").decode(bytes);
}
function htmlToText(value: string): string {
  return decodeEntities(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function decodeEntities(value: string): string {
  return value.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'");
}
function finish(
  clock: Clock,
  status: ToolResult["status"],
  error?: ToolResultError,
  output?: unknown,
  metadataValue?: Record<string, unknown>
): ToolResult {
  const endedAt = new Date();
  return {
    duration_ms: Math.max(0, Math.round(performance.now() - clock.started)),
    ended_at: endedAt.toISOString(),
    invocation_id: clock.invocationID,
    started_at: clock.startedAt.toISOString(),
    status,
    ...(output === undefined ? {} : { output }),
    ...(error === undefined ? {} : { error }),
    ...(metadataValue === undefined ? {} : { metadata: metadataValue })
  };
}
function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
function metadata(options: FetchOptions): Record<string, unknown> {
  return {
    http: {
      max_bytes: options.maxBytes,
      max_redirects: options.maxRedirects,
      provider_id: HTTP_READONLY_PROVIDER_ID,
      timeout_ms: options.timeoutMs,
      tool_name: URL_FETCH_TOOL_NAME
    }
  };
}
function boundedInt(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(cleanString(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(cleanString).filter(Boolean))];
}
function mediaType(value: string): string {
  return value.split(";")[0]?.trim().toLowerCase() ?? "";
}
function redirectLimitError(maxRedirects: number): Error {
  const error = new Error(`HTTP redirect limit exceeded: ${maxRedirects}`);
  error.name = "HttpRedirectLimitError";
  return error;
}
function isRedirectLimitError(error: unknown): error is Error {
  return error instanceof Error && error.name === "HttpRedirectLimitError";
}
function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}
function invocationClock(invocationID: string | undefined): Clock {
  return { invocationID: invocationID || crypto.randomUUID(), started: performance.now(), startedAt: new Date() };
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "HTTP fetch failed";
}
function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
