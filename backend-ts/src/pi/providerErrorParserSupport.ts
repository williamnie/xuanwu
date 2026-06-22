import { redactSensitiveText } from "../util/redact.ts";

export const SENSITIVE_KEY_PATTERN =
  /(?:token|secret|password|api[_-]?key|access[_-]?key|authorization|credential)/i;

const ABSOLUTE_PATH_PATTERN = /(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)|(?:[A-Za-z]:\\[^\s"'`,;)]+)/g;
const SECRET_PARAM_PATTERN = /([?&](?:token|secret|password|api[_-]?key|access[_-]?key)=)[^&\s]+/gi;
const PATH_KEY_PATTERN = /(?:path|cwd|dir|directory|home)/i;
const SUMMARY_LIMIT = 260;

export function parseRetryTime(value: string, now: Date): string | undefined {
  const numeric = Number(value.trim());
  if (Number.isFinite(numeric)) return durationTime(numeric, "s", now);
  return naturalRetryTime(value, now) ?? parsedDate(value);
}

export function parseResetTime(value: string, now: Date): string | undefined {
  const numeric = Number(value.trim());
  if (Number.isFinite(numeric)) return epochTime(numeric);
  return naturalRetryTime(value, now) ?? dateAfterMarker(value) ?? parsedDate(value);
}

export function naturalRetryTime(value: string, now: Date): string | undefined {
  if (!/(?:try again|retry|reset|rate limit)/i.test(value)) return undefined;
  const duration = durationMs(value);
  if (duration !== undefined) return iso(now.getTime() + duration);
  return dateAfterMarker(value) ?? undefined;
}

export function durationTime(value: number, unit: "ms" | "s", now: Date): string | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined;
  return iso(now.getTime() + value * (unit === "ms" ? 1 : 1_000));
}

export function epochTime(value: number): string | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const timestamp = value > 1_000_000_000_000 ? value : value * 1_000;
  return iso(timestamp);
}

export function secondsUntil(value: string | undefined, now: Date): number | undefined {
  if (!value) return undefined;
  return Math.max(0, Math.ceil((Date.parse(value) - now.getTime()) / 1_000));
}

export function parseStatusCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) return value;
  if (typeof value !== "string") return undefined;
  const match = value.match(/^\s*([1-5]\d{2})\s*$/);
  return match ? Number(match[1]) : undefined;
}

export function statusCodeFromText(value: string): number | undefined {
  const lower = value.toLowerCase();
  const explicit = value.match(/\b(?:http|status(?:[_ -]?code)?|api returned|returned)\s*:?\s*([1-5]\d{2})\b/i);
  if (explicit) return Number(explicit[1]);
  if (/\b429\b/.test(value) && /too many requests|rate limit|quota temporarily unavailable/.test(lower)) return 429;
  if (/\b401\b/.test(value) && /unauthorized|authentication/.test(lower)) return 401;
  if (/\b403\b/.test(value) && /forbidden|permission|access denied/.test(lower)) return 403;
  return undefined;
}

export function redactedProviderErrorSummary(texts: string[], statusCode?: number): string {
  const picked = texts.find((text) =>
    /error|429|rate|retry|reconnecting|disconnect|unauthorized|permission|timeout|timed out|network|transport|deadline|eof/i.test(text));
  const fallback = statusCode?.toString() ?? "unknown provider error";
  return truncate(redactedSummary(picked || texts[0] || fallback));
}

export function parseJsonMaybe(value: unknown): unknown {
  return typeof value === "string" ? parseJsonObject(value) ?? value : value;
}

export function parseJsonObject(value: string): unknown | undefined {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function durationMs(value: string): number | undefined {
  const pattern = /(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec(?:ond)?s?|m|min(?:ute)?s?|h|hours?)/gi;
  let total = 0;
  for (const match of value.matchAll(pattern)) total += Number(match[1]) * unitMs(match[2] ?? "");
  return total > 0 ? total : undefined;
}

function unitMs(unit: string): number {
  const value = unit.toLowerCase();
  if (value.startsWith("ms") || value.startsWith("millisecond")) return 1;
  if (value.startsWith("m") && !value.startsWith("ms")) return 60_000;
  if (value.startsWith("h")) return 3_600_000;
  return 1_000;
}

function parsedDate(value: string): string | undefined {
  const timestamp = Date.parse(value.trim());
  return Number.isFinite(timestamp) ? iso(timestamp) : undefined;
}

function dateAfterMarker(value: string): string | undefined {
  const match = value.match(/\b(?:reset|retry|try again)\s+(?:at|on)\s+(.+)$/i);
  return match ? parsedDate(match[1] ?? "") : undefined;
}

function redactedSummary(value: unknown): string {
  const parsed = typeof value === "string" ? parseJsonObject(value) : undefined;
  if (parsed) return JSON.stringify(redactValue(parsed));
  if (typeof value === "string") return sanitizeText(value);
  return JSON.stringify(redactValue(value));
}

function redactValue(value: unknown, key = ""): unknown {
  if (value === null || value === undefined) return value;
  if (SENSITIVE_KEY_PATTERN.test(key)) return "[redacted]";
  if (PATH_KEY_PATTERN.test(key)) return "[redacted-path]";
  if (typeof value === "string") return sanitizeText(value);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactValue(item));
  if (typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([itemKey, item]) => [
    itemKey,
    redactValue(item, itemKey)
  ]));
}

function sanitizeText(value: string): string {
  return redactSensitiveText(value)
    .replace(SECRET_PARAM_PATTERN, "$1[redacted]")
    .replace(ABSOLUTE_PATH_PATTERN, "[redacted-path]")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(value: string): string {
  return value.length <= SUMMARY_LIMIT ? value : `${value.slice(0, SUMMARY_LIMIT - 1)}…`;
}

function iso(timestamp: number): string | undefined {
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().replace(/\.\d{3}Z$/, "Z") : undefined;
}
