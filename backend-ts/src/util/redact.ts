const SENSITIVE_LINE_MARKERS = [
  "authorization:",
  "auth_token",
  "auth-token",
  "codex_runner_auth_token",
  "codex_runner_bun_auth_token",
  "bearer "
];

const SECRET_ASSIGNMENT_PATTERN =
  /([A-Z0-9_-]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|ACCESS[_-]?KEY)[A-Z0-9_-]*\s*[:=]\s*)[^\s,;]+/gi;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const ABSOLUTE_PATH_PATTERN = /(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g;
const STACK_LINE_PATTERN = /^\s*at\s+\S+/;

export function redactSensitiveText(text: string): string {
  return text.split(/\r?\n/).map(redactSensitiveLine).join("\n");
}

export function redactedUserVisibleText(text: string): string {
  return redactSensitiveText(text)
    .split(/\r?\n/)
    .filter((line) => !STACK_LINE_PATTERN.test(line))
    .join(" ")
    .replace(ABSOLUTE_PATH_PATTERN, "[redacted-path]")
    .replace(/\s+/g, " ")
    .trim();
}

function redactSensitiveLine(line: string): string {
  if (isSensitiveLine(line)) return "[redacted sensitive line]";
  return line
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1[redacted]");
}

function isSensitiveLine(line: string): boolean {
  const lower = line.toLowerCase();
  return SENSITIVE_LINE_MARKERS.some((marker) => lower.includes(marker));
}
