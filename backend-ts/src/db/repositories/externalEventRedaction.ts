type JsonEvidence = Record<string, unknown> | unknown[];

export function redactSecrets(value: unknown, key = ""): unknown {
  if (isSensitiveKey(key)) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (value && typeof value === "object") return redactObject(value as Record<string, unknown>);
  return typeof value === "string" ? redactedString(value, key) : value;
}

export function redactedString(value: string, key: string): string {
  if (value === "" || isSensitiveKey(key)) return isSensitiveKey(key) ? "[redacted]" : value;
  try {
    const url = new URL(value);
    for (const param of url.searchParams.keys()) {
      if (isSensitiveKey(param)) url.searchParams.set(param, "[redacted]");
    }
    return url.toString();
  } catch {
    return value;
  }
}

function redactObject(value: Record<string, unknown>): JsonEvidence {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactSecrets(item, key)]));
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return /token|secret|password|authorization|apikey|accesskey/.test(normalized);
}
