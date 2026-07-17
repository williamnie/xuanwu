import { isSensitiveFieldName, redactionRegistry } from "../../security/redactionRegistry.ts";

export function redactSecrets(value: unknown, key = ""): unknown {
  return redactionRegistry.redactValue(value, key);
}

export function redactedString(value: string, key: string): string {
  if (value === "" || isSensitiveFieldName(key)) return isSensitiveFieldName(key) ? "[redacted]" : value;
  return String(redactionRegistry.redactValue(value));
}
