import type { ModelInfo, Options, ProcessTransportOptions, Query, QueryTransportProvider, SDKMessage, Transport } from "@qoder-ai/qoder-agent-sdk";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import { qoderResultFailure } from "./events.ts";
import { cleanString } from "../../util/values.ts";
import { QoderSdkFacade, QoderSdkFacadeOptions, QoderRunOptions, QoderMessageContext, QoderQueryResult, QoderExecutionError, DEFAULT_QODER_MODEL_DISCOVERY_TIMEOUT_MS, QoderProcessLease } from "./sdkFacadeModel.ts";
import { ActiveQuery, buildQoderQueryOptions, qoderMessageTerminal } from "./sdkFacade.ts";
import { assertObservedPermissionMode, qoderModelDiscoveryStep } from "./sdkFacadeDiscovery.ts";
import { required, qoderError, qoderUsageProjection, qoderException, controlPrompt, validModelInfo } from "./sdkFacadeUsage.ts";

export class RealQoderSdkFacade implements QoderSdkFacade {
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
      sessionId: cleanString(options.resume) || cleanString(options.sessionId),
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
        if (cleanString(message.session_id)) active.sessionId = cleanString(message.session_id);
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
        messageRef: cleanString(resultMessage.uuid),
        sessionId: cleanString(resultMessage.session_id) || active.sessionId,
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
        cwd: cleanString(this.config.cwd) || process.cwd(),
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
