import type { JsonRpcParams } from "./jsonRpc.ts";
import { codexProviderApprovalDecision } from "./approvalBroker.ts";
import {
  CodexThreadLifecycleError,
  normalizeThreadListResult,
  normalizeThreadResult,
  normalizeThreadStartResult,
  normalizeTurnStartResult,
  threadIDParams,
  threadListParams,
  threadStartParams,
  turnInterruptParams,
  turnStartParams
} from "./threadLifecycle.ts";
import type {
  CodexUserInput,
  ThreadListInput,
  ThreadListResult,
  ThreadStartInput,
  ThreadStartResult,
  ThreadSummary,
  TurnInterruptResult,
  TurnStartOptions,
  TurnStartResult
} from "./threadLifecycle.ts";

export { CodexThreadLifecycleError } from "./threadLifecycle.ts";
export type {
  ThreadLifecycleErrorDetail,
  ThreadListInput,
  ThreadListResult,
  ThreadStartInput,
  ThreadStartResult,
  ThreadSummary,
  TurnInterruptResult,
  TurnStartOptions,
  TurnStartResult
} from "./threadLifecycle.ts";

const CLIENT_INFO = { name: "codex-issue-runner", version: "0.1.0" } as const;
const PROVIDER_CODEX = "codex";

export type CodexRpcClient = {
  request(method: string, params?: JsonRpcParams): Promise<unknown>;
  generation?(): number;
  resolveApprovalRequest?(requestID: string, decision: ApprovalDecision): Promise<unknown>;
};

export type CodexInitializeResult = {
  capabilities: Record<string, unknown>;
  protocolVersion: string;
  serverInfo?: { name: string; version: string };
};

export type ModelListInput = { includeHidden?: boolean };
export type ModelListResult = { data: Model[]; nextCursor?: string };
export type Model = {
  additionalSpeedTiers: string[];
  defaultReasoningEffort: string;
  defaultServiceTier: string;
  description: string;
  displayName: string;
  hidden: boolean;
  id: string;
  inputModalities?: string[];
  isDefault: boolean;
  model: string;
  serviceTiers: ModelServiceTier[];
  supportedReasoningEfforts: ReasoningEffortOption[];
};
export type ReasoningEffortOption = { description: string; reasoningEffort: string };
export type ModelServiceTier = { description: string; id: string; name: string };
export type ApprovalDecision = { decision: string; scope?: string };

export class CodexAdapter {
  private initialized?: Promise<CodexInitializeResult>;
  private initializedGeneration?: number;

  constructor(private readonly rpc: CodexRpcClient) {}

  async initialize(): Promise<CodexInitializeResult> {
    const generation = this.rpc.generation?.();
    if (this.initialized && generation !== undefined && generation !== this.initializedGeneration) {
      this.initialized = undefined;
    }
    this.initialized ??= this.initializeOnce();
    this.initializedGeneration = generation;
    try {
      return await this.initialized;
    } catch (error) {
      this.initialized = undefined;
      this.initializedGeneration = undefined;
      throw error;
    }
  }

  private async initializeOnce(): Promise<CodexInitializeResult> {
    return normalizeInitializeResult(await this.rpc.request("initialize", {
      clientInfo: CLIENT_INFO,
      capabilities: { experimentalApi: true }
    }));
  }

  async listModels(input: ModelListInput = {}): Promise<ModelListResult> {
    const params = { includeHidden: input.includeHidden === true };
    return normalizeModelListResult(await this.rpc.request("model/list", params));
  }

  async startThread(input: ThreadStartInput): Promise<ThreadStartResult> {
    const result = await this.lifecycleRequest("thread/start", threadStartParams(input));
    return normalizeThreadStartResult(result);
  }

  async listThreads(input: ThreadListInput = {}): Promise<ThreadListResult> {
    const result = await this.lifecycleRequest("thread/list", threadListParams(input));
    return normalizeThreadListResult(result);
  }

  async readThread(threadID: string): Promise<ThreadSummary> {
    const result = await this.lifecycleRequest("thread/read", { ...threadIDParams(threadID), includeTurns: true });
    return normalizeThreadResult(result);
  }

  async resumeThread(threadID: string): Promise<ThreadSummary> {
    const result = await this.lifecycleRequest("thread/resume", threadIDParams(threadID));
    return normalizeThreadResult(result);
  }

  async setThreadName(threadID: string, name: string): Promise<{ ok: true; provider_session_id: string }> {
    await this.lifecycleRequest("thread/name/set", { ...threadIDParams(threadID), name });
    return { ok: true, provider_session_id: threadID.trim() };
  }

  async startTurn(threadID: string, input: CodexUserInput[], options: TurnStartOptions = {}): Promise<TurnStartResult> {
    const cleanThreadID = threadID.trim();
    const result = await this.lifecycleRequest("turn/start", turnStartParams(cleanThreadID, input, options));
    return normalizeTurnStartResult(cleanThreadID, result);
  }

  async steerTurn(threadID: string, turnID: string, input: CodexUserInput[]): Promise<TurnStartResult> {
    const cleanThreadID = threadID.trim();
    const cleanTurnID = turnID.trim();
    const result = await this.lifecycleRequest("turn/steer", { threadId: cleanThreadID, expectedTurnId: cleanTurnID, input });
    return normalizeTurnStartResult(cleanThreadID, { turnId: cleanTurnID, ...recordValue(result) });
  }

  async resolveApproval(requestID: string, decision: ApprovalDecision): Promise<{ ok: true }> {
    const cleanID = requestID.trim();
    if (this.rpc.resolveApprovalRequest) {
      await this.rpc.resolveApprovalRequest(cleanID, decision);
      return { ok: true };
    }
    const scopedDecision = codexProviderApprovalDecision(decision);
    await this.lifecycleRequest("approval/resolve", {
      requestId: cleanID,
      decision: scopedDecision.decision,
      scope: scopedDecision.scope ?? ""
    });
    return { ok: true };
  }

  async interruptTurn(threadID: string, turnID: string): Promise<TurnInterruptResult> {
    const cleanThreadID = threadID.trim();
    const cleanTurnID = turnID.trim();
    await this.lifecycleRequest("turn/interrupt", turnInterruptParams(cleanThreadID, cleanTurnID));
    return { ok: true, provider_session_id: cleanThreadID, turn_id: cleanTurnID };
  }

  private async lifecycleRequest(method: string, params: JsonRpcParams): Promise<unknown> {
    try {
      return await this.rpc.request(method, params);
    } catch (error) {
      throw new CodexThreadLifecycleError(method, error);
    }
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
    additionalSpeedTiers: stringArrayField(raw, "additionalSpeedTiers", "additional_speed_tiers") ?? [],
    serviceTiers: serviceTiers(raw),
    defaultServiceTier: stringField(raw, "defaultServiceTier") || stringField(raw, "default_service_tier"),
    inputModalities: stringArrayField(raw, "inputModalities", "input_modalities")
  };
}

function serviceTiers(raw: Record<string, unknown>): ModelServiceTier[] {
  return arrayField(raw, ["serviceTiers", "service_tiers"])
    .map(normalizeServiceTier)
    .filter((item) => item.id !== "");
}

function normalizeServiceTier(value: unknown): ModelServiceTier {
  const raw = recordValue(value);
  return {
    id: stringField(raw, "id"),
    name: stringField(raw, "name"),
    description: stringField(raw, "description")
  };
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
