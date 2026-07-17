import { redactSensitiveText } from "../../../util/redact.ts";
import { isSensitiveFieldName } from "../../../security/redactionRegistry.ts";

const ABSOLUTE_PATH_PATTERN = /(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g;

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
    isSensitiveFieldName(key) ? "[redacted]" : redactAuditValue(entry)
  ]));
}
