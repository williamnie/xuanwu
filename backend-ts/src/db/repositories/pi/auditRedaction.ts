import { redactSensitiveText } from "../../../util/redact.ts";

const ABSOLUTE_PATH_PATTERN = /(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g;
const SAFE_TOKEN_KEYS = new Set(["input_tokens", "last_token_usage", "output_tokens", "token_count", "total_tokens"]);
const SENSITIVE_KEY_PATTERN = /(^|[_-])(access[_-]?key|api[_-]?key|auth[_-]?token|authorization|bearer|password|secret|token)([_-]|$)/i;

export function redactAuditText(value: string): string {
  return redactSensitiveText(value).replace(ABSOLUTE_PATH_PATTERN, "[redacted-path]");
}

export function redactAuditJsonText(value: string): string {
  const text = value.trim();
  if (text === "") return "{}";
  try {
    return JSON.stringify(redactAuditValue(JSON.parse(text) as unknown));
  } catch {
    return JSON.stringify(redactAuditText(text));
  }
}

function redactAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAuditValue);
  if (value && typeof value === "object") return redactAuditObject(value as Record<string, unknown>);
  if (typeof value === "string") return redactAuditText(value);
  return value;
}

function redactAuditObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    isSensitiveKey(key) ? "[redacted]" : redactAuditValue(entry)
  ]));
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return !SAFE_TOKEN_KEYS.has(normalized) && SENSITIVE_KEY_PATTERN.test(normalized);
}
