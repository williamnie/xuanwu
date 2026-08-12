import type {
  AuthOptions,
  Options,
  ProcessTransportOptions,
  Query,
  QueryTransportProvider,
  SDKMessage,
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
export { QODER_VERSION_PAIR } from "./version.ts";

export type QoderTerminal = "succeeded" | "failed" | "interrupted" | "cancelled";

export type QoderRunOptions = {
  approvalPolicy?: string;
  cwd: string;
  invocationKey: string;
  model?: string;
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
  usage?: { totalTokens?: number; toolUses?: number; durationMs?: number };
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
    onMessage?: (message: SDKMessage, context: { interrupted: boolean }) => void
  ): Promise<QoderQueryResult>;
  /** 精确中断 invocation 对应的 active Query。 */
  interrupt(invocationKey: string): Promise<void>;
  activeCount(): number;
  processLeases(): readonly QoderProcessLease[];
  close(): Promise<void>;
}

export type QoderSdkFacadeOptions = {
  /** Offline fake-stream seam; production uses the pinned SDK query export. */
  queryFactory?: (input: { prompt: string; options: Options }) => Query;
};

export function buildQoderQueryOptions(
  options: Partial<QoderRunOptions> = {},
  runtime?: ProviderRuntimeConfig
): Pick<Options,
  "abortController" | "allowedTools" | "auth" | "cwd" | "disallowedTools" | "env" | "model" |
  "pathToQoderCLIExecutable" | "permissionMode" | "resume" | "sessionId" | "systemPrompt" | "tools"
> {
  const policy = qoderPolicyOptions(options.approvalPolicy, options.sandbox);
  const model = clean(options.model) || clean(runtime?.model);
  const systemPrompt = clean(options.systemPrompt);
  return {
    ...(runtime ? {
      auth: buildQoderAuthOptions(runtime),
      env: managedExecutionEnvironment({
        ...runtime.env,
        ...(runtime.configDir ? { QODER_CONFIG_DIR: runtime.configDir } : {})
      }),
      pathToQoderCLIExecutable: runtime.command
    } : {}),
    ...policy,
    cwd: clean(options.cwd) || undefined,
    model: model || undefined,
    resume: clean(options.resume) || undefined,
    sessionId: clean(options.resume) === "" ? clean(options.sessionId) || undefined : undefined,
    systemPrompt: systemPrompt ? { type: "preset", preset: "qodercli", append: systemPrompt } : undefined
  };
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

  constructor(
    private readonly config: ProviderRuntimeConfig,
    private readonly options: QoderSdkFacadeOptions
  ) {}

  async run(
    prompt: string,
    options: QoderRunOptions,
    onMessage?: (message: SDKMessage, context: { interrupted: boolean }) => void
  ): Promise<QoderQueryResult> {
    const invocationKey = required(options.invocationKey, "Qoder invocation key");
    if (this.active.has(invocationKey)) throw qoderError("configuration", `Qoder invocation ${invocationKey} is already active`);
    assertQoderReasoningEffort(options.reasoningEffort);
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
        if (message.type === "system" && message.subtype === "init") initSeen = true;
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
      onMessage?.(resultMessage, { interrupted: active.interruptRequested });
      const terminal = active.interruptRequested ? "interrupted" : qoderMessageTerminal(resultMessage);
      if (terminal === "failed") throw new QoderExecutionError(qoderResultFailure(resultMessage));
      if (!terminal) throw qoderError("protocol", "Qoder result did not map to a terminal", { sessionId: active.sessionId });
      return {
        invocationRef: invocationKey,
        messageRef: clean(resultMessage.uuid),
        sessionId: clean(resultMessage.session_id) || active.sessionId,
        terminal,
        usage: {
          durationMs: resultMessage.duration_ms,
          totalTokens: resultMessage.usage.input_tokens + resultMessage.usage.output_tokens
        }
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
        if (result) onMessage?.(result, { interrupted: interrupted.keys.includes(runOptions.invocationKey) });
        const terminal = interrupted.keys.includes(runOptions.invocationKey)
          ? "interrupted"
          : result ? qoderMessageTerminal(result) : options.terminal;
        if (!terminal) throw qoderError("protocol", "Qoder query ended without an authoritative result", { sessionId });
        if (terminal === "failed" && result) throw new QoderExecutionError(qoderResultFailure(result));
        return {
          invocationRef: runOptions.invocationKey,
          messageRef: result ? clean(result.uuid) : "",
          sessionId,
          terminal
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
    processLeases: () => [],
    async close() { active.clear(); }
  };
  return { facade, interrupted, calls };
}

function qoderPolicyOptions(
  approvalPolicy: string | undefined,
  sandbox: string | undefined
): Pick<Options, "allowedTools" | "disallowedTools" | "permissionMode" | "tools"> {
  const approval = clean(approvalPolicy) || "never";
  if (approval !== "never") {
    throw qoderError("policy_input", `Qoder approval policy ${approval} requires the later approval integration`);
  }
  const mode = clean(sandbox) || "workspace-write";
  if (mode === "danger-full-access") {
    throw qoderError("policy_input", "Qoder danger-full-access is disabled until an explicit unsafe policy exists");
  }
  if (mode === "read-only") {
    const allowedTools = ["Read", "Grep", "Glob"];
    return {
      allowedTools,
      disallowedTools: ["Agent", "Bash", "Edit", "NotebookEdit", "Write"],
      permissionMode: "dontAsk",
      tools: allowedTools
    };
  }
  if (mode !== "workspace-write") throw qoderError("policy_input", `Unsupported Qoder sandbox ${mode}`);
  const allowedTools = ["Read", "Grep", "Glob", "Edit", "Write"];
  return {
    allowedTools,
    disallowedTools: ["Bash", "NotebookEdit"],
    permissionMode: "dontAsk",
    tools: allowedTools
  };
}

function assertQoderReasoningEffort(value: string | undefined): void {
  const effort = clean(value);
  if (effort !== "") {
    throw qoderError("policy_input", `Qoder reasoning effort ${effort} has no stable typed SDK mapping in the pinned runtime`);
  }
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
