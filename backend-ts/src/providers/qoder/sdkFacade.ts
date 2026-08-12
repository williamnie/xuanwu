import type { AuthOptions, Options, SDKMessage } from "@qoder-ai/qoder-agent-sdk";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
export { QODER_VERSION_PAIR } from "./version.ts";

/**
 * P11：Qoder SDK facade——薄隔离层（Q0 gate：SDK 1.0.20 / CLI 1.1.18）。
 * provider 只依赖 facade 接口，测试用 fake facade；真实实现惰性动态 import SDK
 * （qodercli 未安装时 available=false → factory autoDetect not_ready）。
 */

export type QoderTerminal = "succeeded" | "failed" | "interrupted" | "cancelled";

export type QoderRunOptions = {
  model?: string;
  /** 仅用于预分配新 Session；恢复历史 Session 必须使用 resume。 */
  sessionId?: string;
  resume?: string;
};

export type QoderQueryResult = {
  sessionId: string;
  terminal: QoderTerminal;
  usage?: { totalTokens?: number; toolUses?: number; durationMs?: number };
};

export interface QoderSdkFacade {
  readonly available: boolean;
  /** 启动一轮 prompt（单轮或续接），返回 authoritative terminal。 */
  run(prompt: string, options?: QoderRunOptions): Promise<QoderQueryResult>;
  /** 中断 active turn（SDK Query.interrupt）。 */
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export function buildQoderQueryOptions(
  options: QoderRunOptions = {},
  runtime?: ProviderRuntimeConfig
): Pick<Options, "auth" | "env" | "model" | "pathToQoderCLIExecutable" | "resume" | "sessionId"> {
  return {
    ...(runtime ? {
      auth: buildQoderAuthOptions(runtime),
      env: {
        ...runtime.env,
        ...(runtime.configDir ? { QODER_CONFIG_DIR: runtime.configDir } : {})
      },
      pathToQoderCLIExecutable: runtime.command
    } : {}),
    model: options.model,
    resume: options.resume,
    sessionId: options.resume === undefined ? options.sessionId : undefined
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

/** P11：真实 facade——动态 import @qoder-ai/qoder-agent-sdk（qodercli 缺失时 available=false）。 */
export function createQoderSdkFacade(config: ProviderRuntimeConfig): QoderSdkFacade {
  return new RealQoderSdkFacade(config);
}

class RealQoderSdkFacade implements QoderSdkFacade {
  available = true;
  private interruptFn?: () => Promise<unknown>;

  constructor(private readonly config: ProviderRuntimeConfig) {}

  async run(prompt: string, options: QoderRunOptions = {}): Promise<QoderQueryResult> {
    const sdk = await import("@qoder-ai/qoder-agent-sdk");
    const queryOptions = buildQoderQueryOptions(options, this.config);
    const query = sdk.query({ prompt, options: queryOptions });
    this.interruptFn = () => query.interrupt();
    let sessionId = "";
    let terminal: QoderTerminal | undefined;
    let usage: QoderQueryResult["usage"];
    try {
      for await (const message of query) {
        if (typeof message.session_id === "string" && message.session_id !== "") sessionId = message.session_id;
        const messageTerminal = qoderMessageTerminal(message);
        if (messageTerminal !== undefined) terminal = messageTerminal;
        if (message.type === "result") {
          usage = {
            durationMs: message.duration_ms
          };
        }
      }
    } catch (error) {
      terminal = "failed";
      // 保持 sessionId 可用；错误由上层包装为 ProviderRunResult
    } finally {
      this.interruptFn = undefined;
    }
    return { sessionId, terminal: terminal ?? "failed", usage };
  }

  async interrupt(): Promise<void> {
    const fn = this.interruptFn;
    if (fn) await fn();
  }

  async close(): Promise<void> {
    // query generator 已消费；无独立 close
  }
}

/** P11：fake facade（测试用）——注入消息流与终态。 */
export function createFakeQoderSdkFacade(
  messages: Array<SDKMessage | "throw">,
  options: { terminal?: QoderTerminal; sessionId?: string } = {}
): { facade: QoderSdkFacade; interrupted: { count: number }; calls: QoderRunOptions[] } {
  const interrupted = { count: 0 };
  const calls: QoderRunOptions[] = [];
  const facade: QoderSdkFacade = {
    available: true,
    async run(prompt, runOptions = {}) {
      void prompt;
      calls.push({ ...runOptions });
      let sessionId = options.sessionId ?? "qoder-session-1";
      let terminal = options.terminal;
      for (const message of messages) {
        if (message === "throw") throw new Error("sdk failure");
        if (typeof message.session_id === "string" && message.session_id !== "") sessionId = message.session_id;
        terminal = qoderMessageTerminal(message) ?? terminal;
      }
      return { sessionId, terminal: terminal ?? "failed" };
    },
    async interrupt() {
      interrupted.count += 1;
    },
    async close() {}
  };
  return { facade, interrupted, calls };
}
