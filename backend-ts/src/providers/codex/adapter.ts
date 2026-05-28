import type { JsonRpcParams } from "./jsonRpc.ts";

const CLIENT_INFO = { name: "codex-issue-runner-bun", version: "0.1.0" } as const;
const PROVIDER_CODEX = "codex";

export type CodexRpcClient = {
  request(method: string, params?: JsonRpcParams): Promise<unknown>;
};

export type CodexInitializeResult = {
  capabilities: Record<string, unknown>;
  protocolVersion: string;
  serverInfo?: { name: string; version: string };
};

export type ModelListInput = { includeHidden?: boolean };
export type ModelListResult = { data: Model[]; nextCursor?: string };
export type Model = {
  defaultReasoningEffort: string;
  description: string;
  displayName: string;
  hidden: boolean;
  id: string;
  inputModalities?: string[];
  isDefault: boolean;
  model: string;
  supportedReasoningEfforts: ReasoningEffortOption[];
};
export type ReasoningEffortOption = { description: string; reasoningEffort: string };

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

export class CodexAdapter {
  constructor(private readonly rpc: CodexRpcClient) {}

  async initialize(): Promise<CodexInitializeResult> {
    return normalizeInitializeResult(await this.rpc.request("initialize", {
      clientInfo: CLIENT_INFO,
      capabilities: { experimentalApi: true }
    }));
  }

  async listModels(input: ModelListInput = {}): Promise<ModelListResult> {
    const params = { includeHidden: input.includeHidden === true };
    return normalizeModelListResult(await this.rpc.request("model/list", params));
  }

  async listThreads(input: ThreadListInput = {}): Promise<ThreadListResult> {
    return normalizeThreadListResult(await this.rpc.request("thread/list", threadListParams(input)));
  }
}

function normalizeInitializeResult(value: unknown): CodexInitializeResult {
  const raw = recordValue(value);
  return {
    protocolVersion: stringField(raw, "protocolVersion") || stringField(raw, "protocol_version"),
    serverInfo: serverInfo(raw),
    capabilities: recordField(raw, "capabilities") ?? {}
  };
}

function normalizeModelListResult(value: unknown): ModelListResult {
  const raw = recordValue(value);
  return {
    data: arrayField(raw, ["data", "models"], value).map(normalizeModel).filter((item) => item.id !== ""),
    nextCursor: stringField(raw, "nextCursor") || stringField(raw, "next_cursor") || undefined
  };
}

function normalizeModel(value: unknown): Model {
  const raw = recordValue(value);
  const id = stringField(raw, "id") || stringField(raw, "model");
  const efforts = reasoningEfforts(raw);
  return {
    id,
    model: stringField(raw, "model") || id,
    displayName: stringField(raw, "displayName") || stringField(raw, "name") || id,
    description: stringField(raw, "description"),
    isDefault: boolField(raw, "isDefault") || boolField(raw, "default"),
    hidden: boolField(raw, "hidden"),
    defaultReasoningEffort: stringField(raw, "defaultReasoningEffort") || efforts[0]?.reasoningEffort || "",
    supportedReasoningEfforts: efforts,
    inputModalities: stringArrayField(raw, "inputModalities", "input_modalities")
  };
}

function normalizeThreadListResult(value: unknown): ThreadListResult {
  const raw = recordValue(value);
  return {
    data: arrayField(raw, ["data", "threads"], value).map(normalizeThread).filter((item) => item.provider_session_id !== ""),
    nextCursor: stringField(raw, "nextCursor") || stringField(raw, "next_cursor") || undefined,
    backwardsCursor: stringField(raw, "backwardsCursor") || stringField(raw, "backwards_cursor") || undefined
  };
}

function normalizeThread(value: unknown): ThreadSummary {
  const raw = recordValue(value);
  const rawID = threadID(raw);
  const thread = {
    id: providerSessionKey(rawID),
    sessionId: rawID,
    provider: PROVIDER_CODEX,
    provider_session_id: rawID,
    ephemeral: boolField(raw, "ephemeral")
  } as ThreadSummary;
  copyThreadFields(thread, raw);
  if (isRunningStatus(thread.status)) thread.isRunning = true;
  return thread;
}

function copyThreadFields(target: ThreadSummary, raw: Record<string, unknown>): void {
  copyString(target, raw, "preview");
  copyString(target, raw, "modelProvider");
  copyString(target, raw, "path");
  copyString(target, raw, "cwd");
  copyString(target, raw, "cliVersion");
  copyString(target, raw, "source");
  copyString(target, raw, "origin");
  copyOptionalString(target, raw, "name");
  copyRaw(target, raw, "status");
  copyRaw(target, raw, "turns");
  copyRaw(target, raw, "gitInfo");
  copyNumber(target, raw, "createdAt");
  copyNumber(target, raw, "updatedAt");
}

function threadListParams(input: ThreadListInput): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (input.limit && input.limit > 0) params.limit = input.limit;
  if (input.cursor?.trim()) params.cursor = input.cursor.trim();
  return params;
}

function reasoningEfforts(raw: Record<string, unknown>): ReasoningEffortOption[] {
  return arrayField(raw, ["supportedReasoningEfforts", "reasoningEfforts"])
    .map(normalizeReasoningEffort)
    .filter((item) => item.reasoningEffort !== "");
}

function normalizeReasoningEffort(value: unknown): ReasoningEffortOption {
  if (typeof value === "string") return { reasoningEffort: value, description: "" };
  const raw = recordValue(value);
  return {
    reasoningEffort: stringField(raw, "reasoningEffort") || stringField(raw, "value") || stringField(raw, "id"),
    description: stringField(raw, "description") || stringField(raw, "label")
  };
}

function serverInfo(raw: Record<string, unknown>): CodexInitializeResult["serverInfo"] {
  const info = recordField(raw, "serverInfo") ?? recordField(raw, "server_info");
  const name = stringField(info ?? {}, "name");
  const version = stringField(info ?? {}, "version") || stringField(raw, "serverVersion") || stringField(raw, "version");
  return name || version ? { name, version } : undefined;
}

function threadID(raw: Record<string, unknown>): string {
  return stringField(raw, "id") || stringField(raw, "threadId") ||
    stringField(raw, "thread_id") || stringField(raw, "sessionId");
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

function recordField(raw: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  return typeof raw[key] === "object" && raw[key] !== null && !Array.isArray(raw[key])
    ? raw[key] as Record<string, unknown>
    : undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function arrayField(raw: Record<string, unknown>, keys: string[], direct?: unknown): unknown[] {
  for (const key of keys) {
    if (Array.isArray(raw[key])) return raw[key] as unknown[];
  }
  return Array.isArray(direct) ? direct : [];
}

function stringArrayField(raw: Record<string, unknown>, primary: string, fallback: string): string[] | undefined {
  const values = arrayField(raw, [primary, fallback]).filter((value): value is string => typeof value === "string");
  return values.length > 0 ? values : undefined;
}

function stringField(raw: Record<string, unknown>, key: string): string {
  return typeof raw[key] === "string" ? raw[key].trim() : "";
}

function boolField(raw: Record<string, unknown>, key: string): boolean {
  return raw[key] === true;
}
