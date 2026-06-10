import { redactSensitiveText } from "../../util/redact.ts";

const PROVIDER_CODEX = "codex";

export type ThreadStartInput = {
  approvalPolicy?: string;
  cwd: string;
  developerInstructions?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  sandbox?: string;
  threadSource?: string;
};

export type ThreadStartResult = ThreadSummary & {
  thread_id: string;
};

export type CodexUserInput = {
  detail?: "high" | "original";
  name?: string;
  path?: string;
  text?: string;
  text_elements?: unknown[];
  type: string;
  url?: string;
};

export type TurnStartOptions = {
  approvalPolicy?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  sandbox?: string;
};

export type TurnStartResult = {
  provider: typeof PROVIDER_CODEX;
  provider_session_id: string;
  sessionId: string;
  turn_id: string;
};

export type TurnInterruptResult = {
  ok: true;
  provider_session_id: string;
  turn_id: string;
};

export type ThreadListInput = { cursor?: string; limit?: number };
export type ThreadListResult = {
  backwardsCursor?: string;
  data: ThreadSummary[];
  nextCursor?: string;
};
export type ThreadSummary = Record<string, unknown> & {
  ephemeral: boolean;
  id: string;
  provider: typeof PROVIDER_CODEX;
  provider_session_id: string;
  sessionId: string;
};

export type ThreadLifecycleErrorDetail = {
  code: string;
  message: string;
  method: string;
  provider: typeof PROVIDER_CODEX;
};

export class CodexThreadLifecycleError extends Error {
  readonly detail: ThreadLifecycleErrorDetail;

  constructor(method: string, error: unknown) {
    const message = redactedErrorMessage(error);
    super(`codex ${method} failed: ${message}`);
    this.name = "CodexThreadLifecycleError";
    this.detail = { provider: PROVIDER_CODEX, method, code: errorCode(error), message };
  }
}

export function normalizeThreadStartResult(value: unknown): ThreadStartResult {
  const thread = normalizeThreadResult(value);
  return { ...thread, thread_id: thread.provider_session_id };
}

export function normalizeThreadListResult(value: unknown): ThreadListResult {
  const raw = recordValue(value);
  return {
    data: arrayField(raw, ["data", "threads"], value).map(normalizeThread).filter((item) => item.provider_session_id !== ""),
    nextCursor: stringField(raw, "nextCursor") || stringField(raw, "next_cursor") || undefined,
    backwardsCursor: stringField(raw, "backwardsCursor") || stringField(raw, "backwards_cursor") || undefined
  };
}

export function normalizeThreadResult(value: unknown): ThreadSummary {
  const raw = recordValue(value);
  return normalizeThread(raw.thread ?? raw.data ?? value);
}

export function normalizeTurnStartResult(threadID: string, value: unknown): TurnStartResult {
  const raw = recordValue(value);
  const turn = recordValue(raw.turn ?? raw.data ?? value);
  const turnID = stringField(turn, "id") || stringField(raw, "turnId") || stringField(raw, "turn_id");
  return { provider: PROVIDER_CODEX, sessionId: threadID.trim(), provider_session_id: threadID.trim(), turn_id: turnID };
}

export function threadStartParams(input: ThreadStartInput): Record<string, unknown> {
  const params: Record<string, unknown> = {
    cwd: input.cwd,
    model: input.model && input.model !== "codex-default" ? input.model : null,
    approvalPolicy: approvalPolicy(input.approvalPolicy),
    sandbox: input.sandbox?.trim() || "workspace-write",
    developerInstructions: input.developerInstructions?.trim() ?? "",
    ephemeral: false
  };
  const source = threadSource(input.threadSource);
  if (source) params.threadSource = source;
  if (input.serviceTier?.trim()) params.serviceTier = input.serviceTier.trim();
  if (input.reasoningEffort?.trim()) params.config = { model_reasoning_effort: input.reasoningEffort.trim() };
  return params;
}

export function threadListParams(input: ThreadListInput): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (input.limit && input.limit > 0) params.limit = input.limit;
  if (input.cursor?.trim()) params.cursor = input.cursor.trim();
  return params;
}

export function threadIDParams(threadID: string): Record<string, unknown> {
  return { threadId: threadID.trim() };
}

export function turnStartParams(threadID: string, input: CodexUserInput[], options: TurnStartOptions = {}): Record<string, unknown> {
  const params: Record<string, unknown> = { threadId: threadID.trim(), input };
  if (options.model?.trim() && options.model.trim() !== "codex-default") params.model = options.model.trim();
  if (options.reasoningEffort?.trim()) params.effort = options.reasoningEffort.trim();
  if (options.serviceTier?.trim()) params.serviceTier = options.serviceTier.trim();
  if (options.approvalPolicy?.trim()) params.approvalPolicy = approvalPolicy(options.approvalPolicy);
  if (options.sandbox?.trim()) params.sandboxPolicy = turnSandboxPolicy(options.sandbox);
  return params;
}

export function turnInterruptParams(threadID: string, turnID: string): Record<string, unknown> {
  return { threadId: threadID.trim(), turnId: turnID.trim() };
}

export function textInput(text: string): CodexUserInput {
  return { type: "text", text, text_elements: [] };
}

export function localImageInput(path: string, detail: "high" | "original" = "high"): CodexUserInput {
  return { type: "localImage", path: path.trim(), detail };
}

function normalizeThread(value: unknown): ThreadSummary {
  const raw = recordValue(value);
  const rawID = threadID(raw);
  const thread = {
    id: providerSessionKey(rawID),
    sessionId: rawID,
    provider: PROVIDER_CODEX,
    provider_session_id: rawID,
    ephemeral: raw.ephemeral === true
  } as ThreadSummary;
  copyThreadFields(thread, raw);
  if (isRunningStatus(thread.status)) thread.isRunning = true;
  return thread;
}

function copyThreadFields(target: ThreadSummary, raw: Record<string, unknown>): void {
  for (const key of ["preview", "modelProvider", "path", "cwd", "cliVersion", "source", "origin"]) copyString(target, raw, key);
  copyOptionalString(target, raw, "name");
  for (const key of ["status", "turns", "gitInfo"]) copyRaw(target, raw, key);
  for (const key of ["createdAt", "updatedAt"]) copyNumber(target, raw, key);
}

function threadID(raw: Record<string, unknown>): string {
  return stringField(raw, "id") || stringField(raw, "threadId") ||
    stringField(raw, "thread_id") || stringField(raw, "sessionId");
}

function threadSource(value: string | undefined): string {
  const source = value?.trim() ?? "";
  return ["user", "subagent", "memory_consolidation"].includes(source) ? source : "";
}

function approvalPolicy(value: string | undefined): string {
  const policy = value?.trim() ?? "";
  switch (policy) {
    case "":
    case "never":
    case "untrusted":
    case "on-failure":
    case "on-request": return policy || "never";
    case "always": return "untrusted";
    case "danger-only": return "on-request";
    default: return policy;
  }
}

function turnSandboxPolicy(value: string | undefined): Record<string, string> {
  switch (value?.trim()) {
    case "read-only":
    case "readOnly": return { type: "readOnly" };
    case "danger-full-access":
    case "dangerFullAccess": return { type: "dangerFullAccess" };
    case "":
    case undefined:
    case "workspace-write":
    case "workspaceWrite": return { type: "workspaceWrite" };
    default: return { type: value.trim() };
  }
}

function providerSessionKey(sessionID: string): string {
  if (sessionID === "" || sessionID.startsWith(`${PROVIDER_CODEX}:`)) return sessionID;
  return `${PROVIDER_CODEX}:${sessionID}`;
}

function isRunningStatus(value: unknown): boolean {
  if (typeof value === "string") return isRunningText(value);
  const raw = recordValue(value);
  return ["type", "state", "status"].some((key) => isRunningText(stringField(raw, key)));
}

function isRunningText(value: string): boolean {
  return ["running", "inprogress", "in-progress", "streaming", "busy", "active"]
    .includes(value.trim().toLowerCase().replaceAll("_", "-"));
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayField(raw: Record<string, unknown>, keys: string[], direct?: unknown): unknown[] {
  for (const key of keys) if (Array.isArray(raw[key])) return raw[key] as unknown[];
  return Array.isArray(direct) ? direct : [];
}

function stringField(raw: Record<string, unknown>, key: string): string {
  return typeof raw[key] === "string" ? raw[key].trim() : "";
}

function copyString(target: Record<string, unknown>, raw: Record<string, unknown>, key: string): void {
  const value = stringField(raw, key);
  if (value !== "") target[key] = value;
}

function copyOptionalString(target: Record<string, unknown>, raw: Record<string, unknown>, key: string): void {
  if (typeof raw[key] === "string") target[key] = raw[key];
}

function copyNumber(target: Record<string, unknown>, raw: Record<string, unknown>, key: string): void {
  if (typeof raw[key] === "number") target[key] = raw[key];
}

function copyRaw(target: Record<string, unknown>, raw: Record<string, unknown>, key: string): void {
  if (raw[key] !== undefined) target[key] = raw[key];
}

function redactedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(message || "unknown error");
}

function errorCode(error: unknown): string {
  const match = redactedErrorMessage(error).match(/codex rpc ([^:]+):/);
  return match?.[1] ?? "codex_thread_lifecycle_error";
}
