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
  SessionMessageInput,
  SessionMessageResult,
  SessionRef
} from "../types.ts";
import { PiRpcTransport, type PiRpcEvent } from "./rpcTransport.ts";
import { detectProviderCommand } from "../core/command.ts";
import { normalizedRunEvent } from "../runEvents.ts";

/**
 * P10：Pi Coding Agent executor（RPC transport，G10 gate 已通过）。
 * - terminal 收敛：`agent_settled`（fully settled，无自动 retry/compaction）为 authoritative terminal；
 * - session：以 `get_state.sessionFile` 作为可恢复 ref；recover 用 `switch_session` 后发送 prompt；
 * - interrupt：`abort` command；model list：`get_available_models`。
 */

export type PiExecutorProviderOptions = {
  transport?: PiRpcTransport;
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
};

export class PiExecutorProvider implements ExecutorProvider {
  readonly id = "pi-coding-agent" as const;
  readonly capabilities: readonly ExecutorCapability[] = ["issue_execution", "sessions", "resume_session", "interrupt", "model_list"];
  private transport?: PiRpcTransport;
  private transportCwd = "";
  private active = false;
  private lastSessionRef = "";

  constructor(private readonly options: PiExecutorProviderOptions = {}) {
    this.transport = options.transport;
  }

  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    assertPiApprovalPolicy(input.approvalPolicy);
    const transport = await this.beginOperation(input.cwd, "", piToolsForSandbox(input.sandbox));
    try {
      await transport.send({ type: "new_session" });
      await this.applyExecutionSettings(transport, input.model, input.reasoningEffort);
      const outcome = await this.promptAndWait(transport, input.prompt, input.onEvent, input);
      this.lastSessionRef = outcome.sessionRef;
      return {
        runId: outcome.invocationRef,
        session: outcome.sessionRef ? { provider: this.id, sessionId: outcome.sessionRef } : undefined
      };
    } finally {
      this.active = false;
    }
  }

  async recover(input: ProviderRecoveryInput): Promise<ProviderRunResult> {
    assertPiApprovalPolicy(input.approvalPolicy);
    const transport = await this.beginOperation(input.cwd, input.session.sessionId, piToolsForSandbox(input.sandbox));
    try {
      await this.applyExecutionSettings(transport, input.model, input.reasoningEffort);
      const outcome = await this.promptAndWait(transport, input.prompt, input.onEvent, input);
      this.lastSessionRef = outcome.sessionRef;
      return {
        runId: outcome.invocationRef,
        session: outcome.sessionRef ? { provider: this.id, sessionId: outcome.sessionRef } : undefined
      };
    } finally {
      this.active = false;
    }
  }

  async createSession(input: SessionCreateInput): Promise<SessionCreateResult> {
    assertPiApprovalPolicy(input.approvalPolicy);
    const transport = await this.beginOperation(input.cwd, "", piToolsForSandbox(input.sandbox));
    try {
      await transport.send({ type: "new_session" });
      await this.applyExecutionSettings(transport, input.model, input.reasoningEffort);
      const state = input.prompt?.trim()
        ? await this.promptAndWait(transport, input.prompt, undefined, input)
        : await this.sessionState(transport);
      const sessionRef = state?.sessionRef ?? "";
      this.lastSessionRef = sessionRef;
      return {
        id: sessionRef,
        provider: this.id,
        provider_session_id: sessionRef,
        thread_id: sessionRef,
        turn_id: undefined
      };
    } finally {
      this.active = false;
    }
  }

  async interrupt(_input: InterruptInput): Promise<void> {
    if (!this.transport?.running) return;
    await this.transport.send({ type: "abort" });
  }

  async listModels(): Promise<unknown> {
    const transport = await this.beginOperation();
    try {
      const data = await transport.send({ type: "get_available_models" });
      const models = Array.isArray(data)
        ? data
        : data && typeof data === "object" && Array.isArray((data as { models?: unknown }).models)
          ? (data as { models: unknown[] }).models
          : [];
      return models.map((entry) => normalizeModel(entry));
    } finally {
      this.active = false;
    }
  }

  async sendSessionMessage(input: SessionMessageInput): Promise<SessionMessageResult> {
    assertPiApprovalPolicy(input.approvalPolicy);
    const transport = await this.beginOperation(input.cwd, input.sessionId, piToolsForSandbox(input.sandbox));
    try {
      await this.applyExecutionSettings(transport, input.model, input.reasoningEffort);
      const outcome = await this.promptAndWait(transport, input.prompt ?? "", undefined, input);
      const sessionRef = outcome.sessionRef || input.sessionId;
      this.lastSessionRef = sessionRef;
      return { provider: this.id, provider_session_id: sessionRef, sessionId: sessionRef, turn_id: "" };
    } finally {
      this.active = false;
    }
  }

  runtimeStatus(): ProviderRuntimeStatus {
    const detected = detectProviderCommand(this.options.command ?? "pi");
    return {
      active_sessions: this.active ? 1 : 0,
      api_key_configured: false,
      auth_configured: true,
      auth_source: "local-settings",
      executable_ready: detected.installed,
      mode: "rpc",
      ready: detected.installed,
      ...(detected.reason ? { reason: detected.reason } : {}),
      version: piVersion(detected.path)
    };
  }

  async stop(): Promise<void> {
    await this.transport?.stop();
  }

  processLeases() {
    const lease = this.transport?.processLease();
    return lease ? [lease] : [];
  }

  private async beginOperation(cwd = "", sessionRef = "", tools: readonly string[] = []): Promise<PiRpcTransport> {
    if (this.active) throw new Error("Pi provider is already executing another operation");
    this.active = true;
    try {
      const targetCwd = cwd.trim() || this.options.cwd?.trim() || "";
      if (!this.transport || (!this.options.transport && this.transportCwd !== targetCwd)) {
        await this.transport?.stop();
        this.transport = new PiRpcTransport({
          command: this.options.command,
          cwd: targetCwd,
          env: this.options.env,
          timeoutMs: Math.min(this.options.timeoutMs ?? 30_000, 60_000)
        });
        this.transportCwd = targetCwd;
      }
      await this.transport.startForSession(sessionRef, tools);
      return this.transport;
    } catch (error) {
      this.active = false;
      throw error;
    }
  }

  private async sessionState(transport: PiRpcTransport): Promise<{ sessionId: string; sessionRef: string } | undefined> {
    const data = await transport.send({ type: "get_state" });
    if (data && typeof data === "object" && "sessionId" in data) {
      const state = data as { sessionId: unknown };
      const sessionId = String(state.sessionId ?? "");
      return { sessionId, sessionRef: sessionId };
    }
    return undefined;
  }

  private async promptAndWait(
    transport: PiRpcTransport,
    prompt: string,
    sink: ProviderRunInput["onEvent"],
    input: { projectId?: string; issueId?: number; prompt?: string }
  ): Promise<{ invocationRef: string; sessionRef: string }> {
    if (prompt.trim() === "") throw new Error("Pi RPC prompt must not be empty");
    const invocationRef = `pi-rpc-${crypto.randomUUID()}`;
    const terminal = this.waitForTerminal(transport, sink, input);
    try {
      await transport.send({ id: invocationRef, type: "prompt", message: prompt });
      return { invocationRef, ...await terminal };
    } catch (error) {
      await transport.stop().catch(() => {});
      await terminal.catch(() => {});
      throw error;
    }
  }

  private async applyExecutionSettings(transport: PiRpcTransport, model?: string, thinking?: string): Promise<void> {
    const selectedModel = model?.trim();
    if (selectedModel && selectedModel !== "codex-default") {
      const modelsPayload = await transport.send({ type: "get_available_models" });
      const candidates = modelRecords(modelsPayload);
      const match = candidates.find((entry) => {
        const id = String(entry.id ?? entry.modelId ?? "");
        const provider = String(entry.provider ?? "");
        return selectedModel === id || selectedModel === `${provider}/${id}`;
      });
      if (!match) throw new Error(`Pi model ${JSON.stringify(selectedModel)} is not available`);
      await transport.send({
        type: "set_model",
        provider: String(match.provider ?? ""),
        modelId: String(match.id ?? match.modelId ?? "")
      });
    }
    const level = thinking?.trim();
    if (level) await transport.send({ type: "set_thinking_level", level });
  }

  /**
   * 等待 authoritative terminal：`agent_settled`（fully settled）。
   * 事件流同时转发给 runner（provider.message / provider.error）。
   */
  private waitForTerminal(
    transport: PiRpcTransport,
    sink: ProviderRunInput["onEvent"],
    input: { projectId?: string; issueId?: number; prompt?: string }
  ): Promise<{ sessionRef: string }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let failureReason = "";
      const settleTimeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error("pi rpc agent did not settle within timeout"));
        }
      }, this.options.timeoutMs ?? 30 * 60 * 1000);
      const cleanup = () => {
        clearTimeout(settleTimeout);
        off();
      };
      const off = transport.onEvent((event: PiRpcEvent) => {
        switch (event.type) {
          case "agent_settled":
            if (settled) break;
            settled = true;
            cleanup();
            void this.sessionState(transport).then((state) => {
              const sessionRef = state?.sessionRef ?? this.lastSessionRef;
              const session = sessionRef ? { provider: this.id, sessionId: sessionRef } as const : undefined;
              if (failureReason) {
                sink?.({
                  error: failureReason,
                  provider: this.id,
                  runEvent: normalizedRunEvent({
                    kind: "error",
                    method: "pi-coding-agent/agent_settled",
                    outcome: "failed",
                    provider: this.id,
                    session
                  }),
                  session,
                  type: "provider.error"
                });
                reject(new Error(failureReason));
                return;
              }
              sink?.({
                provider: this.id,
                runEvent: normalizedRunEvent({
                  kind: "completed",
                  method: "pi-coding-agent/agent_settled",
                  outcome: "succeeded",
                  provider: this.id,
                  session
                }),
                session,
                status: "completed",
                type: "provider.completed"
              });
              resolve({ sessionRef });
            }).catch(() => {
              if (failureReason) reject(new Error(failureReason));
              else resolve({ sessionRef: this.lastSessionRef });
            });
            break;
          case "error":
          case "exit":
            if (settled) break;
            settled = true;
            cleanup();
            reject(new Error(event.type === "exit" ? "pi rpc exited before agent settled" : String(event.message ?? "pi rpc error")));
            break;
          case "stderr":
            sink?.({ provider: this.id, type: "provider.error", text: String(event.text ?? "") });
            break;
          case "message_update": {
            const update = recordValue(event.assistantMessageEvent);
            if (update.type === "error") failureReason = String(update.error ?? update.reason ?? "Pi model request failed");
            if (update.type === "text_delta" && typeof update.delta === "string" && update.delta !== "") {
              sink?.({ provider: this.id, type: "provider.message", text: update.delta });
            }
            break;
          }
          case "auto_retry_end":
            if (event.success === false) failureReason = String(event.finalError ?? "Pi model request failed after retries");
            break;
          default:
            break;
        }
      });
      // 立即 get_state 拿到 session id（prompt 前后皆可）
      void this.sessionState(transport).then((state) => {
        if (state?.sessionRef) this.lastSessionRef = state.sessionRef;
      }).catch(() => {});
    });
  }
}

function normalizeModel(entry: unknown): { id: string; display_name: string } {
  if (entry && typeof entry === "object") {
    const record = entry as Record<string, unknown>;
    const modelId = String(record.id ?? record.modelId ?? "");
    const provider = String(record.provider ?? "");
    const id = provider && modelId ? `${provider}/${modelId}` : modelId;
    return { id, display_name: String(record.display_name ?? record.name ?? id) };
  }
  return { id: String(entry), display_name: String(entry) };
}

function modelRecords(value: unknown): Array<Record<string, unknown>> {
  const models = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { models?: unknown }).models)
      ? (value as { models: unknown[] }).models
      : [];
  return models.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object");
}

function piVersion(path?: string): string {
  if (!path) return "";
  try {
    const result = Bun.spawnSync([path, "--version"], { stderr: "ignore", stdout: "pipe" });
    return result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : "";
  } catch {
    return "";
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function assertPiApprovalPolicy(value: string | undefined): void {
  const policy = value?.trim() ?? "";
  if (policy !== "" && policy !== "never") {
    throw new Error(`Pi Coding Agent does not support host approval policy ${JSON.stringify(policy)}`);
  }
}

function piToolsForSandbox(value: string | undefined): readonly string[] {
  const sandbox = value?.trim() ?? "";
  if (sandbox === "read-only") return ["read", "grep", "find", "ls"];
  if (sandbox === "danger-full-access") return [];
  throw new Error(
    `Pi Coding Agent cannot enforce sandbox policy ${JSON.stringify(sandbox || "workspace-write")}; choose "read-only" or explicitly choose "danger-full-access"`
  );
}
