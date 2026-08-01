const SENSITIVE_MEMORY_ERROR = "memory content contains sensitive data";
const SENSITIVE_LINE_MARKERS = [
  "authorization:", "auth_token", "auth-token", "bearer ", "api_key=", "api-key=",
  "password=", "secret=", "token=", ".ssh/", "id_rsa", "id_ed25519", "credentials.json",
  "private_key"
];
const SECRET_ASSIGNMENT_PATTERN = /[A-Z0-9_-]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|ACCESS[_-]?KEY)[A-Z0-9_-]*\s*[:=]\s*[^\s,;]+/i;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]+/i;

export const REUSABLE_MEMORY_KINDS = [
  "user_preference",
  "project_preference",
  "decision",
  "debugging_pattern",
  "resolution",
  "workflow",
  "constraint"
] as const;

export type ReusableMemoryKind = (typeof REUSABLE_MEMORY_KINDS)[number];
export type ReusableMemoryWrite = {
  confidence?: string;
  content: string;
  evidenceRef?: string;
  kind: string;
  memoryKey: string;
  scope: string;
  source?: string;
  userAuthorized?: boolean;
};

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

export function reusableMemoryRejection(input: ReusableMemoryWrite): string | undefined {
  if (clean(input.content) === "") return "memory content is required";
  if (!isReusableMemoryKind(input.kind)) return "memory kind is not reusable";
  if (!validMemoryKey(input.memoryKey)) return "memory_key must be a stable lowercase identifier";
  if (clean(input.confidence) === "low") return "low-confidence observations are not memory";
  if (containsSensitiveMemoryContent(input.content)) return SENSITIVE_MEMORY_ERROR;
  if (transientStatusSnapshot(input.content) && !reusableResolution(input)) {
    return "current Work/Run/Issue status snapshots are not memory";
  }
  if (managerSource(input.source)) return managerMemoryRejection(input);
  if (normalChatSource(input.source)) {
    return input.userAuthorized === true ? undefined : "normal chat memory requires an explicit user statement";
  }
  if (["approved_memory_action", "manual_settings"].includes(clean(input.source))) {
    return input.userAuthorized === true ? undefined : "memory action requires explicit approval";
  }
  return "this runtime source cannot create durable memory";
}

export function retrievableMemoryKind(kind: string): boolean {
  const normalized = clean(kind).toLowerCase();
  return isReusableMemoryKind(normalized) || LEGACY_REUSABLE_KINDS.has(normalized);
}

export function retrievableMemoryContent(kind: string, content: string): boolean {
  return !transientStatusSnapshot(content) || reusableExperienceContent(kind, content);
}

export function transientStatusSnapshot(content: string): boolean {
  const text = content.trim();
  return STATUS_SNAPSHOT_PATTERNS.some((pattern) => pattern.test(text));
}

function managerMemoryRejection(input: ReusableMemoryWrite): string | undefined {
  if (!EXPERIENCE_MEMORY_KINDS.has(clean(input.kind).toLowerCase())) {
    return "manager cycles may remember only reusable debugging patterns or resolutions";
  }
  if (!authoritativeEvidenceRef(input.evidenceRef)) {
    return "manager-cycle experience memory requires a Handoff, Evidence, Run, or Work reference";
  }
  return reusableResolution(input) ? undefined : "experience memory must include root cause and resolution or verification";
}

function reusableResolution(input: ReusableMemoryWrite): boolean {
  return reusableExperienceContent(input.kind, input.content);
}

function reusableExperienceContent(kind: string, value: string): boolean {
  if (!EXPERIENCE_MEMORY_KINDS.has(clean(kind).toLowerCase())) return false;
  const content = value.trim();
  return ROOT_CAUSE_PATTERN.test(content) && RESOLUTION_PATTERN.test(content);
}

function isReusableMemoryKind(kind: string): kind is ReusableMemoryKind {
  return (REUSABLE_MEMORY_KINDS as readonly string[]).includes(clean(kind).toLowerCase());
}

function validMemoryKey(value: string): boolean {
  return /^[a-z0-9][a-z0-9._:/-]{2,119}$/.test(clean(value));
}

function authoritativeEvidenceRef(value: string | undefined): boolean {
  return /^(?:handoff|evidence|run|work|issue_event):\S+$/i.test(clean(value));
}

function managerSource(source: string | undefined): boolean {
  return clean(source) === "pi_manager_cycle";
}

function normalChatSource(source: string | undefined): boolean {
  return ["feishu_runner_chat", "runner_chat"].includes(clean(source));
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const EXPERIENCE_MEMORY_KINDS = new Set(["debugging_pattern", "resolution"]);
const LEGACY_REUSABLE_KINDS = new Set([
  "preference", "project_policy", "project_policy_memory", "skill_policy", "source_project_hint"
]);
const ROOT_CAUSE_PATTERN = /(?:root cause|根因|原因|caused by|because)/i;
const RESOLUTION_PATTERN = /(?:fix|fixed|修复|解决|处理方式|verification|verified|验证|复验|test)/i;
const STATUS_SNAPSHOT_PATTERNS = [
  /(?:当前|截至|本次|本轮|现在|today|currently|current status|manager cycle observation)/i,
  /(?:status_counts|unfinished_total|active pi_manager sessions)/i,
  /(?:全部终态|没有未完成|无未完成|all terminal|no unfinished|all (?:issues|works?) (?:are |were )?done)/i,
  /(?:issue|work|run|任务)\s*#?\d+[^\n]{0,48}(?:done|failed|cancelled|triage|todo|in_progress|needs_user|失败|已完成|已取消)/i,
  /(?:done|failed|cancelled|triage|todo|in_progress|needs_user)\s*[=:]\s*\d+/i
];

function sensitiveLine(line: string): boolean {
  const lower = line.toLowerCase();
  return SENSITIVE_LINE_MARKERS.some((marker) => lower.includes(marker));
}
