const REDACTED = "[redacted]";
const REDACTED_VALUES = new Set(["", REDACTED, "[redacted sensitive line]", "***", "<redacted>"]);
const SAFE_TOKEN_KEYS = new Set([
  "input_tokens",
  "last_token_usage",
  "max_tokens",
  "output_tokens",
  "token_count",
  "total_tokens"
]);
const SENSITIVE_FIELD_PATTERN = /(?:^|[_.-])(?:access[_-]?key|api[_-]?key|auth[_-]?token|authorization|bearer|cookie|credential|encrypt[_-]?key|password|private[_-]?key|secret|session[_-]?token|token|verification[_-]?token)(?:$|[_.-])/i;
const SENSITIVE_LINE_MARKERS = [
  "authorization:",
  "auth_token",
  "auth-token",
  "codex_runner_auth_token",
  "codex_runner_bun_auth_token",
  "bearer "
];
const SECRET_ASSIGNMENT_PATTERN =
  /([A-Z0-9_-]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)[A-Z0-9_-]*\s*(?:=|:(?!\/\/))\s*)[^\s,;]+/gi;
const SECRET_PHRASE_PATTERN =
  /\b(token|secret|password|api[_-]?key|access[_-]?key)\b\s+(?:is\s+|was\s+)?(?!\[redacted\])[^\s,;]+/gi;
const SECRET_QUERY_PATTERN = /([?&](?:access_token|token|secret|password|api[_-]?key|access[_-]?key)=)(?!\[redacted\])[^&#\s]*/gi;
const BEARER_PATTERN = /Bearer\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]+/gi;
const SECRET_VALUE_PATTERNS = [
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/i,
  /\bBearer\s+(?!\[redacted\])\S+/i,
  /\b[A-Z0-9_-]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)[A-Z0-9_-]*\s*(?:=|:(?!\/\/))\s*(?!\[redacted\])[^\s,;]+/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:gh[oprsu]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,})\b/,
  /\b(?:sk|rk|pk)-(?:live|prod)-[A-Za-z0-9_-]{12,}\b/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/
] as const;

export type RedactionFinding = { kind: "field" | "value"; path: string };

export class RedactionRegistry {
  private readonly values = new Set<string>();

  register(secret: string): void {
    const value = secret.trim();
    if (value.length >= 4 && !REDACTED_VALUES.has(value.toLowerCase())) this.values.add(value);
  }

  unregister(secret: string): void {
    this.values.delete(secret.trim());
  }

  redactText(text: string): string {
    let output = text;
    for (const value of [...this.values].sort((left, right) => right.length - left.length)) {
      output = output.split(value).join(REDACTED);
    }
    return output.split(/\r?\n/).map(redactLine).join("\n");
  }

  redactValue(value: unknown, key = ""): unknown {
    if (isSensitiveFieldName(key)) return REDACTED;
    if (Array.isArray(value)) return value.map((item) => this.redactValue(item));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .map(([childKey, child]) => [childKey, this.redactValue(child, childKey)]));
    }
    return typeof value === "string" ? redactUrl(this.redactText(value)) : value;
  }

  findings(value: unknown): RedactionFinding[] {
    const findings: RedactionFinding[] = [];
    inspect(value, "$", findings, new WeakSet<object>());
    return findings;
  }
}

export const redactionRegistry = new RedactionRegistry();

export function isSensitiveFieldName(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  if (/(?:_changed|_configured|_count|_ref|_status)$/.test(normalized)) return false;
  if (SAFE_TOKEN_KEYS.has(normalized)) return false;
  const compact = normalized.replace(/[^a-z0-9]/g, "");
  return SENSITIVE_FIELD_PATTERN.test(normalized) ||
    /(?:accesskey|apikey|authtoken|authorization|bearer|cookie|credential|encryptkey|password|privatekey|secret|sessiontoken|token|verificationtoken)$/.test(compact);
}

export function containsSecretLikeValue(value: string): boolean {
  const text = value.trim();
  if (REDACTED_VALUES.has(text.toLowerCase())) return false;
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(text));
}

export function registerSecretForRedaction(secret: string): void {
  redactionRegistry.register(secret);
}

export function redactRegisteredSecrets(value: unknown): unknown {
  return redactionRegistry.redactValue(value);
}

function redactLine(line: string): string {
  const lower = line.toLowerCase();
  if (SENSITIVE_LINE_MARKERS.some((marker) => lower.includes(marker))) return "[redacted sensitive line]";
  return line
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1[redacted]")
    .replace(SECRET_PHRASE_PATTERN, (_match, label: string) => `${label} [redacted]`)
    .replace(SECRET_QUERY_PATTERN, "$1[redacted]");
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of url.searchParams.keys()) {
      if (isSensitiveFieldName(key)) url.searchParams.set(key, REDACTED);
    }
    return url.toString();
  } catch {
    return value;
  }
}

function inspect(value: unknown, path: string, findings: RedactionFinding[], seen: WeakSet<object>): void {
  if (typeof value === "string") {
    if (containsSecretLikeValue(value)) findings.push({ kind: "value", path });
    return;
  }
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspect(item, `${path}[${index}]`, findings, seen));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (isSensitiveFieldName(key) && !safeRedactedValue(child)) findings.push({ kind: "field", path: childPath });
    else inspect(child, childPath, findings, seen);
  }
}

function safeRedactedValue(value: unknown): boolean {
  return value === undefined || value === null ||
    (typeof value === "string" && REDACTED_VALUES.has(value.trim().toLowerCase()));
}
