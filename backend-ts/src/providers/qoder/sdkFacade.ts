import type { SDKMessage } from "@qoder-ai/qoder-agent-sdk";

/**
 * P11：Qoder SDK facade——薄隔离层（G11 gate：SDK 1.0.17 / CLI 1.1.14）。
 * provider 只依赖 facade 接口，测试用 fake facade；真实实现惰性动态 import SDK
 * （qodercli 未安装时 available=false → factory autoDetect not_ready）。
 */

export type QoderTerminal = "succeeded" | "failed" | "interrupted" | "cancelled";

export type QoderQueryResult = {
  sessionId: string;
  terminal: QoderTerminal;
  usage?: { totalTokens?: number; toolUses?: number; durationMs?: number };
};

export interface QoderSdkFacade {
  readonly available: boolean;
  /** 启动一轮 prompt（单轮或续接），返回 authoritative terminal。 */
  run(prompt: string, options?: { sessionId?: string; model?: string }): Promise<QoderQueryResult>;
  /** 中断 active turn（SDK Query.interrupt）。 */
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

/** P11：真实 facade——动态 import @qoder-ai/qoder-agent-sdk（qodercli 缺失时 available=false）。 */
export function createQoderSdkFacade(): QoderSdkFacade {
  return new RealQoderSdkFacade();
}

class RealQoderSdkFacade implements QoderSdkFacade {
  available = true;
  private interruptFn?: () => Promise<unknown>;

  async run(prompt: string, options: { sessionId?: string; model?: string } = {}): Promise<QoderQueryResult> {
    const sdk = await import("@qoder-ai/qoder-agent-sdk");
    const queryOptions: Record<string, unknown> = {
      model: options.model ?? undefined,
      sessionId: options.sessionId ?? undefined
    };
    const query = sdk.query({ prompt, options: queryOptions });
    this.interruptFn = () => query.interrupt();
    let sessionId = "";
    let terminal: QoderTerminal = "succeeded";
    let usage: QoderQueryResult["usage"];
    try {
      for await (const message of query) {
        if (typeof message.session_id === "string" && message.session_id !== "") sessionId = message.session_id;
        if (message.type === "system" && message.subtype === "task_notification") {
          const status = message.status;
          if (status === "failed") terminal = "failed";
          else if (status === "stopped") terminal = "interrupted";
          usage = {
            totalTokens: typeof message.usage?.total_tokens === "number" ? message.usage.total_tokens : undefined,
            toolUses: typeof message.usage?.tool_uses === "number" ? message.usage.tool_uses : undefined,
            durationMs: typeof message.usage?.duration_ms === "number" ? message.usage.duration_ms : undefined
          };
        } else if (message.type === "system" && message.subtype === "mirror_error") {
          terminal = "failed";
        }
      }
    } catch (error) {
      terminal = "failed";
      // 保持 sessionId 可用；错误由上层包装为 ProviderRunResult
    } finally {
      this.interruptFn = undefined;
    }
    return { sessionId, terminal, usage };
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
): { facade: QoderSdkFacade; interrupted: { count: number } } {
  const interrupted = { count: 0 };
  const facade: QoderSdkFacade = {
    available: true,
    async run(prompt) {
      void prompt;
      let sessionId = options.sessionId ?? "qoder-session-1";
      let terminal = options.terminal ?? "succeeded";
      for (const message of messages) {
        if (message === "throw") throw new Error("sdk failure");
        if (typeof message.session_id === "string" && message.session_id !== "") sessionId = message.session_id;
        if (message.type === "system" && message.subtype === "task_notification" && message.status === "failed") terminal = "failed";
        if (message.type === "system" && message.subtype === "task_notification" && message.status === "stopped") terminal = "interrupted";
      }
      return { sessionId, terminal };
    },
    async interrupt() {
      interrupted.count += 1;
    },
    async close() {}
  };
  return { facade, interrupted };
}
