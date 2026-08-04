import type {
  ExecutorCapability,
  ExecutorProvider,
  InterruptInput,
  ProviderEvent,
  ProviderRecoveryInput,
  ProviderRunInput,
  ProviderRunResult,
  ProviderRuntimeStatus,
  SessionCreateInput,
  SessionCreateResult,
  SessionListInput,
  SessionListResult,
  SessionMessageInput,
  SessionMessageResult,
  SessionRef
} from "../types.ts";
import { PiRpcTransport, type PiRpcEvent } from "./rpcTransport.ts";

/**
 * P10：Pi Coding Agent executor（RPC transport，G10 gate 已通过）。
 * - terminal 收敛：`agent_settled`（fully settled，无自动 retry/compaction）为 authoritative terminal；
 * - session：`get_state` 返回 `sessionId`；recover 用 `new_session({parentSession})` 树形续接；
 * - interrupt：`abort` command；model list：`get_available_models`。
 */

export type PiExecutorProviderOptions = {
  transport?: PiRpcTransport;
  command?: string;
};

export class PiExecutorProvider implements ExecutorProvider {
  readonly id = "pi" as const;
  readonly capabilities: readonly ExecutorCapability[] = ["issue_execution", "sessions", "resume_session", "interrupt", "model_list"];
  private readonly transport: PiRpcTransport;
  private lastSessionId = "";

  constructor(options: PiExecutorProviderOptions = {}) {
    this.transport = options.transport ?? new PiRpcTransport(options.command);
  }

  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    await this.ensureRunning();
    const sink = input.onEvent;
    const terminal = this.waitForTerminal(sink, input);
    const response = await this.transport.send({ type: "prompt", message: input.prompt });
    void response;
    const outcome = await terminal;
    this.lastSessionId = outcome.sessionId;
    return {
      runId: `pi-run-${input.issueId}`,
      session: outcome.sessionId ? { provider: this.id, sessionId: outcome.sessionId } : undefined
    };
  }

  async recover(input: ProviderRecoveryInput): Promise<ProviderRunResult> {
    await this.ensureRunning();
    const sink = input.onEvent;
    const terminal = this.waitForTerminal(sink, input);
    await this.transport.send({ type: "new_session", parentSession: input.session.sessionId });
    const outcome = await terminal;
    this.lastSessionId = outcome.sessionId;
    return {
      runId: `pi-recover-${input.issueId}`,
      session: outcome.sessionId ? { provider: this.id, sessionId: outcome.sessionId } : undefined
    };
  }

  async createSession(input: SessionCreateInput): Promise<SessionCreateResult> {
    await this.ensureRunning();
    await this.transport.send({ type: "new_session" });
    const state = await this.sessionState();
    const sessionId = state?.sessionId ?? "";
    this.lastSessionId = sessionId;
    return {
      id: sessionId,
      provider: this.id,
      provider_session_id: sessionId,
      thread_id: sessionId,
      turn_id: undefined
    };
  }

  async interrupt(input: InterruptInput): Promise<void> {
    await this.ensureRunning();
    await this.transport.send({ type: "abort" });
  }

  /** P10：tree session fork——new_session(parentSession) 分支续接。 */
  async forkSession(input: { sessionRef: string }): Promise<{ id: string; providerId: string; sessionRef: string; thread_id: string; turn_id: string }> {
    await this.ensureRunning();
    await this.transport.send({ type: "new_session", parentSession: input.sessionRef });
    const state = await this.sessionState();
    const sessionId = state?.sessionId ?? "";
    this.lastSessionId = sessionId;
    return { id: sessionId, providerId: "pi", sessionRef: sessionId, thread_id: sessionId, turn_id: "" };
  }

  async listModels(): Promise<unknown> {
    await this.ensureRunning();
    const data = await this.transport.send({ type: "get_available_models" });
    if (Array.isArray(data)) {
      return data.map((entry) => normalizeModel(entry));
    }
    return [];
  }

  async listSessions(_input: SessionListInput): Promise<SessionListResult> {
    // Pi RPC 无 list 命令（SessionManager 本地索引）；capability-limited：不伪造列表。
    return { data: [], nextCursor: undefined };
  }

  async sendSessionMessage(input: SessionMessageInput): Promise<SessionMessageResult> {
    await this.ensureRunning();
    const prompt = input.prompt ?? "";
    const terminal = this.waitForTerminal(undefined, input);
    await this.transport.send({ type: "prompt", message: prompt, streamingBehavior: "followUp" });
    await terminal;
    return { provider: this.id, provider_session_id: input.sessionId, sessionId: input.sessionId, turn_id: "" };
  }

  runtimeStatus(): ProviderRuntimeStatus {
    return {
      active_sessions: 0,
      api_key_configured: false,
      auth_configured: true,
      auth_source: "local-settings",
      executable_ready: true,
      mode: "rpc",
      ready: true,
      version: "0.83.0"
    };
  }

  async stop(): Promise<void> {
    await this.transport.stop();
  }

  private async ensureRunning(): Promise<void> {
    if (!this.transport.running) await this.transport.start();
  }

  private async sessionState(): Promise<{ sessionId: string } | undefined> {
    const data = await this.transport.send({ type: "get_state" });
    if (data && typeof data === "object" && "sessionId" in data) {
      return { sessionId: String((data as { sessionId: unknown }).sessionId) };
    }
    return undefined;
  }

  /**
   * 等待 authoritative terminal：`agent_settled`（fully settled）。
   * 事件流同时转发给 runner（provider.message / provider.error）。
   */
  private waitForTerminal(
    sink: ProviderRunInput["onEvent"],
    input: { projectId?: string; issueId?: number; prompt?: string }
  ): Promise<{ sessionId: string }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settleTimeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error("pi rpc agent did not settle within timeout"));
        }
      }, 30 * 60 * 1000);
      const cleanup = () => {
        clearTimeout(settleTimeout);
        off();
      };
      const off = this.transport.onEvent((event: PiRpcEvent) => {
        switch (event.type) {
          case "agent_settled":
            if (settled) break;
            settled = true;
            cleanup();
            void this.sessionState().then((state) => resolve({ sessionId: state?.sessionId ?? "" })).catch(() => resolve({ sessionId: "" }));
            break;
          case "stderr":
            sink?.({ provider: this.id, type: "provider.error", text: String(event.text ?? "") });
            break;
          default:
            if (event.type && !event.type.startsWith("agent_") && sink) {
              sink?.({
                provider: this.id,
                type: "provider.message",
                text: String(event.type ?? "")
              });
            }
        }
      });
      // 立即 get_state 拿到 session id（prompt 前后皆可）
      void this.sessionState().then((state) => {
        if (state?.sessionId) this.lastSessionId = state.sessionId;
      }).catch(() => {});
    });
  }
}

function normalizeModel(entry: unknown): { id: string; display_name: string } {
  if (entry && typeof entry === "object") {
    const record = entry as Record<string, unknown>;
    const id = String(record.id ?? record.modelId ?? "");
    return { id, display_name: String(record.display_name ?? record.name ?? id) };
  }
  return { id: String(entry), display_name: String(entry) };
}
