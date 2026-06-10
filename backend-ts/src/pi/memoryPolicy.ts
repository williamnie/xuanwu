const SENSITIVE_MEMORY_ERROR = "memory content contains sensitive data";
const SENSITIVE_LINE_MARKERS = [
  "authorization:", "auth_token", "auth-token", "bearer ", "api_key=", "api-key=",
  "password=", "secret=", "token=", ".ssh/", "id_rsa", "id_ed25519", "credentials.json",
  "private_key"
];
const SECRET_ASSIGNMENT_PATTERN = /[A-Z0-9_-]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|ACCESS[_-]?KEY)[A-Z0-9_-]*\s*[:=]\s*[^\s,;]+/i;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]+/i;

export function assertMemoryContentSafe(content: string): void {
  if (containsSensitiveMemoryContent(content)) throw new Error(SENSITIVE_MEMORY_ERROR);
}

export function memoryRejectedResult(content: string): { reason: string; rejected: true } | undefined {
  return containsSensitiveMemoryContent(content) ? { rejected: true, reason: SENSITIVE_MEMORY_ERROR } : undefined;
}

export function containsSensitiveMemoryContent(content: string): boolean {
  const text = content.trim();
  if (text === "") return false;
  return text.split(/\r?\n/).some(sensitiveLine) || SECRET_ASSIGNMENT_PATTERN.test(text) || BEARER_PATTERN.test(text);
}

function sensitiveLine(line: string): boolean {
  const lower = line.toLowerCase();
  return SENSITIVE_LINE_MARKERS.some((marker) => lower.includes(marker));
}
