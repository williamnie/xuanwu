import type {
  AuthOptions,
  CanUseTool,
  ModelInfo,
  ModelPolicyProvider,
  Options,
  ProcessTransportOptions,
  Query,
  QueryTransportProvider,
  SDKMessage,
  SDKResultMessage,
  Transport
} from "@qoder-ai/qoder-agent-sdk";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import { managedExecutionEnvironment } from "../managedExecution.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import {
  classifyQoderFailure,
  qoderResultFailure,
  type QoderFailureDetails
} from "./events.ts";
import { qoderPermissionOptions } from "./permissionBroker.ts";
import type { ResolvedExecutionPolicy } from "../core/policyContracts.ts";
export { QODER_VERSION_PAIR } from "./version.ts";

export type QoderTerminal = "succeeded" | "failed" | "interrupted" | "cancelled";

export type QoderRunOptions = {
  approvalPolicy?: string;
  canUseTool?: CanUseTool;
  cwd: string;
  invocationKey: string;
  model?: string;
  policy?: ResolvedExecutionPolicy;
  reasoningEffort?: string;
  /** 仅用于预分配新 Session；恢复历史 Session 必须使用 resume。 */
  sessionId?: string;
  resume?: string;
  sandbox?: string;
  systemPrompt?: string;
};

export type QoderQueryResult = {
  invocationRef: string;
  messageRef: string;
  sessionId: string;
  terminal: QoderTerminal;
  usage?: QoderUsageProjection;
};

export type QoderUsageProjection = {
  assistant_requests: Array<Record<string, unknown>>;
  credits: {
    request?: { billable?: boolean; original_value?: number; provenance: "result.usage"; value: number };
    session?: {
      completeness: "partial";
      provenance: "query.getUsageInfo.session" | "result.total_credits";
      semantics: "session_cumulative_unverified";
      value: number;
    };
  };
  model_usage: Record<string, Record<string, unknown>>;
  money: { completeness: "unavailable"; reason: "qoder_credits_are_not_currency" };
  result: {
    cached_input_tokens?: number;
    duration_ms: number;
    input_tokens: number;
    output_tokens: number;
    provenance: "result.usage";
    total_tokens: number;
  };
};

export type QoderMessageContext = {
  interrupted: boolean;
  usage?: QoderUsageProjection;
};

export type QoderProcessLease = {
  commandLabel: string;
  invocationOwner: string;
  pgid?: number;
  pid: number;
  startedAt: string;
};

export class QoderExecutionError extends Error {
  override readonly name = "QoderExecutionError";
  constructor(readonly details: QoderFailureDetails) {
    super(redactSensitiveText(details.message));
  }
}

export interface QoderSdkFacade {
  readonly available: boolean;
  run(
    prompt: string,
    options: QoderRunOptions,
    onMessage?: (message: SDKMessage, context: QoderMessageContext) => void
  ): Promise<QoderQueryResult>;
  listModels(): Promise<ModelInfo[]>;
  /** 精确中断 invocation 对应的 active Query。 */
  interrupt(invocationKey: string): Promise<void>;
  activeCount(): number;
  processLeases(): readonly QoderProcessLease[];
  close(): Promise<void>;
}

export type QoderSdkFacadeOptions = {
  /** Offline fake-stream seam; production uses the pinned SDK query export. */
  queryFactory?: (input: { prompt: string; options: Options }) => Query;
  /** Offline control-query seam; production starts a prompt-free SDK query. */
  discoveryQueryFactory?: (input: { options: Options; prompt: AsyncIterable<never> }) => Promise<Query> | Query;
  modelDiscoveryTimeoutMs?: number;
  modelCacheTtlMs?: number;
  now?: () => number;
};

const DEFAULT_QODER_MODEL_DISCOVERY_TIMEOUT_MS = 12_000;

const QODER_HOST_ENV_KEYS = [
  "HOME",
  "PATH",
  "TMPDIR",
  "USER",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA"
] as const;

export function buildQoderQueryOptions(
  options: Partial<QoderRunOptions> = {},
  runtime?: ProviderRuntimeConfig
): Pick<Options,
  "abortController" | "allowDangerouslySkipPermissions" | "allowedTools" | "auth" | "canUseTool" | "cwd" | "disallowedTools" | "env" | "model" |
  "pathToQoderCLIExecutable" | "permissionMode" | "resolveModel" | "resume" | "sessionId" | "systemPrompt" | "tools"
> {
  const policy = qoderPermissionOptions(options.approvalPolicy, options.sandbox, options.canUseTool, options.policy);
  const model = clean(options.model) || clean(runtime?.model);
  const resolveModel = qoderModelPolicy(model, options.reasoningEffort);
  const systemPrompt = clean(options.systemPrompt);
  return {
    ...(runtime ? {
      auth: buildQoderAuthOptions(runtime),
      env: managedExecutionEnvironment({
        ...qoderHostEnvironment(),
        ...runtime.env,
        ...(runtime.configDir ? { QODER_CONFIG_DIR: runtime.configDir } : {})
      }),
      pathToQoderCLIExecutable: runtime.command
    } : {}),
    ...policy,
    cwd: clean(options.cwd) || undefined,
    model: resolveModel ? undefined : model || undefined,
    resolveModel,
    resume: clean(options.resume) || undefined,
    sessionId: clean(options.resume) === "" ? clean(options.sessionId) || undefined : undefined,
    systemPrompt: systemPrompt ? { type: "preset", preset: "qodercli", append: systemPrompt } : undefined
  };
}

function qoderHostEnvironment(
  environment: Record<string, string | undefined> = process.env
): Record<string, string> {
  return Object.fromEntries(QODER_HOST_ENV_KEYS.flatMap((key) => {
    const value = environment[key]?.trim();
    return value ? [[key, value]] : [];
  }));
}

export function buildQoderAuthOptions(config: ProviderRuntimeConfig): AuthOptions {
  switch (config.authMode) {
    case "pat-env":
      return { type: "accessToken", accessToken: { envVar: "QODER_PERSONAL_ACCESS_TOKEN" } };
    case "pat-secret-ref":
      return { type: "accessToken", accessToken: config.credential ?? "" };
    case "service-account-secret-ref":
      return { type: "serviceAccount", serviceAccountKey: config.credential ?? "" };
    case "local-cli":
    default:
      return { type: "qodercli" };
  }
}

/** 只有主 result 能结束本轮；task_notification 是 Sub-Agent task 进度。 */
export function qoderMessageTerminal(message: SDKMessage): QoderTerminal | undefined {
  if (message.type !== "result") return undefined;
  return message.subtype === "success" && message.is_error === false ? "succeeded" : "failed";
}

export function createQoderSdkFacade(
  config: ProviderRuntimeConfig,
  options: QoderSdkFacadeOptions = {}
): QoderSdkFacade {
  return new RealQoderSdkFacade(config, options);
}

type ActiveQuery = {
  controller: AbortController;
  interruptAcknowledged: boolean;
  interruptRequested: boolean;
  query?: Query;
  sessionId: string;
  startedAt: string;
  timedOut: boolean;
  transport?: Transport & { pid?: number };
};

class RealQoderSdkFacade implements QoderSdkFacade {
  available = true;
  private readonly active = new Map<string, ActiveQuery>();
  private modelCache?: { expiresAt: number; models: ModelInfo[] };

  constructor(
    private readonly config: ProviderRuntimeConfig,
    private readonly options: QoderSdkFacadeOptions
  ) {}

  async run(
    prompt: string,
    options: QoderRunOptions,
    onMessage?: (message: SDKMessage, context: QoderMessageContext) => void
  ): Promise<QoderQueryResult> {
    const invocationKey = required(options.invocationKey, "Qoder invocation key");
    if (this.active.has(invocationKey)) throw qoderError("configuration", `Qoder invocation ${invocationKey} is already active`);
    const active: ActiveQuery = {
      controller: new AbortController(),
      interruptAcknowledged: false,
      interruptRequested: false,
      sessionId: clean(options.resume) || clean(options.sessionId),
      startedAt: new Date().toISOString(),
      timedOut: false
    };
    this.active.set(invocationKey, active);
    const queryOptions: Options = {
      ...buildQoderQueryOptions(options, this.config),
      abortController: active.controller
    };
    const timeoutMs = Math.max(1, this.config.timeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let initSeen = false;
    let resultMessage: Extract<SDKMessage, { type: "result" }> | undefined;
    let resultCount = 0;
    const assistantRequests: SDKMessage[] = [];
    try {
      const query = this.options.queryFactory
        ? this.options.queryFactory({ prompt, options: queryOptions })
        : await this.productionQuery(prompt, queryOptions, active);
      active.query = query;
      timer = setTimeout(() => {
        active.timedOut = true;
        void query.interrupt().catch(() => undefined);
        active.controller.abort(`Qoder query timed out after ${timeoutMs}ms`);
      }, timeoutMs);
      for await (const message of query) {
        if (clean(message.session_id)) active.sessionId = clean(message.session_id);
        if (message.type === "result") {
          resultCount += 1;
          resultMessage = message;
          continue;
        }
        if (message.type === "assistant") assistantRequests.push(message);
        if (message.type === "system" && message.subtype === "init") {
          assertObservedPermissionMode(message, options.policy, active.sessionId);
          initSeen = true;
        }
        onMessage?.(message, { interrupted: active.interruptRequested });
      }
      if (active.timedOut) {
        throw qoderError("timeout", `Qoder query timed out after ${timeoutMs}ms`, { retryable: true, sessionId: active.sessionId });
      }
      if (active.interruptRequested && resultCount === 0) {
        throw qoderError("sdk", "Qoder query interrupted", { code: "interrupted", sessionId: active.sessionId });
      }
      if (resultCount === 0 || !resultMessage) {
        throw qoderError("protocol", "Qoder query ended without an authoritative result", { sessionId: active.sessionId });
      }
      if (resultCount !== 1) {
        throw qoderError("protocol", `Qoder query produced ${resultCount} result messages`, { sessionId: active.sessionId });
      }
      if (!initSeen) throw qoderError("protocol", "Qoder query produced a result before system/init", { sessionId: active.sessionId });
      const usage = await qoderUsageProjection(resultMessage, assistantRequests, query);
      onMessage?.(resultMessage, { interrupted: active.interruptRequested, usage });
      const terminal = active.interruptRequested ? "interrupted" : qoderMessageTerminal(resultMessage);
      if (terminal === "failed") throw new QoderExecutionError(qoderResultFailure(resultMessage));
      if (!terminal) throw qoderError("protocol", "Qoder result did not map to a terminal", { sessionId: active.sessionId });
      return {
        invocationRef: invocationKey,
        messageRef: clean(resultMessage.uuid),
        sessionId: clean(resultMessage.session_id) || active.sessionId,
        terminal,
        usage
      };
    } catch (error) {
      if (error instanceof QoderExecutionError) throw error;
      if (active.timedOut) {
        throw qoderError("timeout", `Qoder query timed out after ${timeoutMs}ms`, { retryable: true, sessionId: active.sessionId });
      }
      if (active.interruptRequested) {
        throw qoderError("sdk", "Qoder query interrupted", { code: "interrupted", sessionId: active.sessionId });
      }
      throw qoderException(error, active.sessionId);
    } finally {
      if (timer) clearTimeout(timer);
      active.transport?.close();
      if (this.active.get(invocationKey) === active) this.active.delete(invocationKey);
    }
  }

  async interrupt(invocationKey: string): Promise<void> {
    const key = required(invocationKey, "Qoder invocation key");
    const active = this.active.get(key);
    if (!active) throw qoderError("configuration", `Qoder invocation ${key} is not active`);
    active.interruptRequested = true;
    if (!active.query) {
      active.interruptAcknowledged = true;
      active.controller.abort("Qoder query interrupted during initialization");
      return;
    }
    try {
      await active.query.interrupt();
      active.interruptAcknowledged = true;
    } catch (error) {
      throw qoderException(error, active.sessionId);
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const now = this.options.now?.() ?? Date.now();
    if (this.modelCache && now < this.modelCache.expiresAt) return structuredClone(this.modelCache.models);
    const timeoutMs = Math.max(1, this.options.modelDiscoveryTimeoutMs ?? DEFAULT_QODER_MODEL_DISCOVERY_TIMEOUT_MS);
    const deadline = Date.now() + timeoutMs;
    const controller = new AbortController();
    const prompt = controlPrompt(controller.signal);
    let transport: Transport | undefined;
    const queryOptions: Options = {
      ...buildQoderQueryOptions({
        approvalPolicy: "never",
        cwd: clean(this.config.cwd) || process.cwd(),
        invocationKey: "qoder-model-discovery",
        sandbox: "read-only"
      }, this.config),
      persistSession: false,
      abortController: controller
    };
    let query: Query | undefined;
    try {
      query = await qoderModelDiscoveryStep(
        this.options.discoveryQueryFactory
          ? Promise.resolve(this.options.discoveryQueryFactory({ options: queryOptions, prompt }))
          : this.productionDiscoveryQuery(prompt, queryOptions, (created) => { transport = created; }),
        deadline
      );
      await qoderModelDiscoveryStep(query.initializationResult(), deadline);
      const models = await qoderModelDiscoveryStep(query.getAvailableModels({ fetchStrategy: "live" }), deadline);
      if (!Array.isArray(models) || models.length === 0) throw new Error("Qoder model discovery returned no models");
      const normalized = models.filter(validModelInfo).map((model) => structuredClone(model));
      if (normalized.length === 0) throw new Error("Qoder model discovery returned malformed models");
      this.modelCache = {
        expiresAt: now + Math.max(1, this.options.modelCacheTtlMs ?? 30_000),
        models: normalized
      };
      return structuredClone(normalized);
    } catch (error) {
      throw qoderError("sdk", `Qoder model discovery failed: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`);
    } finally {
      const interrupted = query?.interrupt().catch(() => undefined);
      controller.abort("Qoder model discovery finished");
      transport?.close();
      await interrupted;
    }
  }

  activeCount(): number {
    return this.active.size;
  }

  processLeases(): readonly QoderProcessLease[] {
    return [...this.active.entries()].flatMap(([invocationOwner, active]) => {
      const pid = active.transport?.pid;
      if (!Number.isSafeInteger(pid) || !pid || pid <= 0) return [];
      return [{
        commandLabel: "qodercli --sdk",
        invocationOwner,
        pgid: pid,
        pid,
        startedAt: active.startedAt
      }];
    });
  }

  async close(): Promise<void> {
    const entries = [...this.active.entries()];
    await Promise.all(entries.map(async ([key, active]) => {
      active.interruptRequested = true;
      await active.query?.interrupt().catch(() => undefined);
      active.controller.abort("Qoder provider shutdown");
      active.transport?.close();
      if (this.active.get(key) === active) this.active.delete(key);
    }));
    this.modelCache = undefined;
  }

  private async productionQuery(prompt: string, options: Options, active: ActiveQuery): Promise<Query> {
    const sdk = await import("@qoder-ai/qoder-agent-sdk");
    const transport: QueryTransportProvider<ProcessTransportOptions> = {
      create: (input) => {
        const created = new sdk.ProcessTransport(input);
        active.transport = created;
        return created;
      }
    };
    return sdk.query({ prompt, options: { ...options, transport } });
  }

  private async productionDiscoveryQuery(prompt: AsyncIterable<never>, options: Options, onTransport: (transport: Transport) => void): Promise<Query> {
    const sdk = await import("@qoder-ai/qoder-agent-sdk");
    options.abortController?.signal.throwIfAborted();
    // 与执行 Query 使用同一已安装的 CLI，避免 SDK 默认 Worker runtime 的额外启动路径。
    const transport: QueryTransportProvider<ProcessTransportOptions> = {
      create: (input) => {
        const created = new sdk.ProcessTransport(input);
        onTransport(created);
        return created;
      }
    };
    return sdk.query({ prompt, options: { ...options, transport } });
  }
}

function qoderModelDiscoveryStep<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const remainingMs = Math.max(1, deadline - Date.now());
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Qoder model discovery timed out")), remainingMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function assertObservedPermissionMode(
  message: SDKMessage,
  policy: ResolvedExecutionPolicy | undefined,
  sessionId: string
): void {
  if (!policy || message.type !== "system" || message.subtype !== "init") return;
  const expected = clean(policy.nativeSummary.permissionMode);
  const observed = clean((message as unknown as Record<string, unknown>).permissionMode);
  if (expected === "" || observed === "" || expected === observed) return;
  throw qoderError(
    "configuration",
    `provider_policy_downgraded: Qoder initialized permission mode ${observed} instead of ${expected}`,
    { code: "provider_policy_downgraded", retryable: false, sessionId }
  );
}

export function createFakeQoderSdkFacade(
  messages: Array<SDKMessage | "throw">,
  options: { terminal?: QoderTerminal; sessionId?: string } = {}
): { facade: QoderSdkFacade; interrupted: { keys: string[] }; calls: QoderRunOptions[] } {
  const interrupted = { keys: [] as string[] };
  const calls: QoderRunOptions[] = [];
  const active = new Set<string>();
  const facade: QoderSdkFacade = {
    available: true,
    async run(_prompt, runOptions, onMessage) {
      calls.push({ ...runOptions });
      active.add(runOptions.invocationKey);
      let sessionId = options.sessionId ?? (clean(runOptions.resume) || clean(runOptions.sessionId) || "qoder-session-1");
      let result: Extract<SDKMessage, { type: "result" }> | undefined;
      let initSeen = false;
      let resultCount = 0;
      try {
        for (const message of messages) {
          if (message === "throw") throw new Error("sdk failure");
          if (clean(message.session_id)) sessionId = clean(message.session_id);
          if (message.type === "result") {
            resultCount += 1;
            result = message;
          } else {
            if (message.type === "system" && message.subtype === "init") initSeen = true;
            onMessage?.(message, { interrupted: interrupted.keys.includes(runOptions.invocationKey) });
          }
        }
        if (resultCount > 1) throw qoderError("protocol", `Qoder query produced ${resultCount} result messages`, { sessionId });
        if (result && !initSeen) throw qoderError("protocol", "Qoder query produced a result before system/init", { sessionId });
        const usage = result ? await qoderUsageProjection(result, [], undefined) : undefined;
        if (result) onMessage?.(result, { interrupted: interrupted.keys.includes(runOptions.invocationKey), usage });
        const terminal = interrupted.keys.includes(runOptions.invocationKey)
          ? "interrupted"
          : result ? qoderMessageTerminal(result) : options.terminal;
        if (!terminal) throw qoderError("protocol", "Qoder query ended without an authoritative result", { sessionId });
        if (terminal === "failed" && result) throw new QoderExecutionError(qoderResultFailure(result));
        return {
          invocationRef: runOptions.invocationKey,
          messageRef: result ? clean(result.uuid) : "",
          sessionId,
          terminal,
          usage
        };
      } finally {
        active.delete(runOptions.invocationKey);
      }
    },
    async interrupt(invocationKey) {
      if (!active.has(invocationKey)) throw new Error(`Qoder invocation ${invocationKey} is not active`);
      interrupted.keys.push(invocationKey);
    },
    activeCount: () => active.size,
    async listModels() { throw new Error("fake Qoder model discovery is not configured"); },
    processLeases: () => [],
    async close() { active.clear(); }
  };
  return { facade, interrupted, calls };
}

function qoderModelPolicy(modelValue: string, effortValue: string | undefined): ModelPolicyProvider | undefined {
  const effort = clean(effortValue);
  if (!effort) return undefined;
  const model = clean(modelValue);
  if (!model) throw qoderError("policy_input", "Qoder reasoning effort requires an explicitly selected model");
  return ({ availableModels }) => {
    const selected = availableModels.find((item) => item.value === model || item.modelId === model || item.model === model);
    if (!selected) throw qoderError("policy_input", `Qoder model ${model} is not in the current account model list`);
    const efforts = Array.isArray(selected.efforts) ? selected.efforts.map(clean).filter(Boolean) : [];
    if (!efforts.includes(effort)) {
      throw qoderError("policy_input", `Qoder model ${model} does not support reasoning effort ${effort}`);
    }
    return { model, parameters: { reasoningEffort: effort } };
  };
}

async function qoderUsageProjection(
  result: SDKResultMessage,
  assistantMessages: SDKMessage[],
  query: Query | undefined
): Promise<QoderUsageProjection> {
  const resultUsage = result.usage;
  const requestCredits = finiteNumber(resultUsage.credits);
  const totalCredits = finiteNumber(result.total_credits);
  const usagePromise = query && typeof query.getUsageInfo === "function" ? query.getUsageInfo() : Promise.resolve(null);
  const usageInfo = await usagePromise.catch(() => null);
  const sessionCredits = finiteNumber(usageInfo?.session?.total_credits);
  return {
    assistant_requests: assistantMessages.flatMap((message) => {
      if (message.type !== "assistant") return [];
      const usage = message.message.usage;
      if (!usage) return [];
      return [compactObject({
        billable: usage.billable,
        credits: finiteNumber(usage.credits),
        input_tokens: finiteNumber(usage.input_tokens),
        model: clean(message.message.model),
        original_credits: finiteNumber(usage.original_credits),
        output_tokens: finiteNumber(usage.output_tokens),
        provenance: "assistant.message.usage",
        request_id: clean(message.request_id) || clean(resultUsage.request_id)
      })];
    }),
    credits: {
      ...(requestCredits === undefined ? {} : {
        request: compactObject({
          billable: resultUsage.billable,
          original_value: finiteNumber(resultUsage.original_credits),
          provenance: "result.usage",
          value: requestCredits
        }) as QoderUsageProjection["credits"]["request"]
      }),
      ...(sessionCredits === undefined && totalCredits === undefined ? {} : {
        session: {
          completeness: "partial",
          provenance: sessionCredits === undefined ? "result.total_credits" : "query.getUsageInfo.session",
          semantics: "session_cumulative_unverified",
          value: sessionCredits ?? totalCredits!
        }
      })
    },
    model_usage: Object.fromEntries(Object.entries(result.modelUsage).map(([model, usage]) => [model, compactObject({
      cache_creation_input_tokens: finiteNumber(usage.cacheCreationInputTokens),
      cache_read_input_tokens: finiteNumber(usage.cacheReadInputTokens),
      credits: finiteNumber(usage.credits),
      input_tokens: finiteNumber(usage.inputTokens),
      output_tokens: finiteNumber(usage.outputTokens),
      web_search_requests: finiteNumber(usage.webSearchRequests)
    })])),
    money: { completeness: "unavailable", reason: "qoder_credits_are_not_currency" },
    result: {
      ...(finiteNumber(resultUsage.cache_read_input_tokens) === undefined ? {} : {
        cached_input_tokens: finiteNumber(resultUsage.cache_read_input_tokens)
      }),
      duration_ms: result.duration_ms,
      input_tokens: resultUsage.input_tokens,
      output_tokens: resultUsage.output_tokens,
      provenance: "result.usage",
      total_tokens: resultUsage.input_tokens + resultUsage.output_tokens
    }
  };
}

function validModelInfo(value: ModelInfo): boolean {
  return clean(value?.value) !== "" && clean(value?.displayName) !== "" && value?.isEnabled !== false;
}

function controlPrompt(signal: AbortSignal): AsyncIterable<never> {
  return {
    async *[Symbol.asyncIterator]() {
      // 不发送用户消息；控制请求完成前保持输入流打开，避免 CLI 因 EOF 提前关闭连接。
      if (signal.aborted) return;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    }
  };
}

function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== ""));
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function qoderException(error: unknown, sessionId: string): QoderExecutionError {
  const raw = recordValue(error);
  const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
  const code = typeof raw.code === "string" || typeof raw.code === "number" ? raw.code : undefined;
  const exitCode = typeof raw.exitCode === "number" || raw.exitCode === null ? raw.exitCode : undefined;
  const signal = typeof raw.signal === "string" || raw.signal === null ? raw.signal : undefined;
  const classified = exitCode !== undefined || signal !== undefined
    ? { category: "process" as const, retryable: false }
    : classifyQoderFailure(message, typeof code === "string" ? code : "", typeof code === "number" ? code : undefined);
  return qoderError(classified.category, message || "Qoder SDK failed", {
    code,
    errorClass: error instanceof Error ? error.name : undefined,
    exitCode,
    retryable: classified.retryable,
    sessionId,
    signal
  });
}

function qoderError(
  category: QoderFailureDetails["category"],
  message: string,
  details: Partial<Omit<QoderFailureDetails, "category" | "message">> = {}
): QoderExecutionError {
  return new QoderExecutionError({ category, message, retryable: false, ...details });
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function required(value: unknown, label: string): string {
  const text = clean(value);
  if (!text) throw qoderError("configuration", `${label} is required`);
  return text;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
