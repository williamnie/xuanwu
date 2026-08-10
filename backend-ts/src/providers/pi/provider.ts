import {
  ProviderInterruptedError,
  type ExecutorCapability,
  type ExecutorProvider,
  type InterruptInput,
  type ProviderEvent,
  type ProviderRecoveryInput,
  type ProviderRunInput,
  type ProviderRunResult,
  type ProviderRuntimeStatus,
  type SessionCreateInput,
  type SessionCreateResult,
  type SessionMessageInput,
  type SessionMessageResult,
  type SessionRef
} from "../types.ts";
import { PiRpcTransport, type PiRpcEvent } from "./rpcTransport.ts";
import { detectProviderCommand } from "../core/command.ts";
import { normalizedRunEvent } from "../runEvents.ts";
import {
  defaultPiSessionFunctions,
  publicPiSessionDetail,
  type PiSessionFunctions
} from "./sessionHistory.ts";

/**
 * P10：Pi Coding Agent executor（RPC transport，G10 gate 已通过）。
 * - terminal 收敛：`agent_settled`（fully settled，无自动 retry/compaction）为 authoritative terminal；
 * - session：prompt 前持久化 `get_state.sessionId`；recover 用 `--session` 启动后发送 prompt；
 * - interrupt：有界 `abort` 后停止独占 transport；model list：`get_available_models`。
 */

export type PiExecutorProviderOptions = {
  transport?: PiRpcTransport;
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  sessionFunctions?: PiSessionFunctions;
  timeoutMs?: number;
};

export class PiExecutorProvider implements ExecutorProvider {
  readonly id = "pi-coding-agent" as const;
  readonly capabilities: readonly ExecutorCapability[] = ["issue_execution", "sessions", "resume_session", "interrupt", "model_list"];
  readonly interruptScope = "active" as const;
  private transport?: PiRpcTransport;
  private transportCwd = "";
  private active = false;
  private interruptRequested = false;
  private lastSessionRef = "";
  private readonly sessionPaths = new Map<string, string>();

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

  async readSession(sessionId: string): Promise<Record<string, unknown>> {
    const id = sessionId.trim();
    if (id === "") throw new Error("Pi session id is required");
    let path = this.sessionPaths.get(id);
    if (!path) {
      path = await this.sessionFunctions().resolve(id);
      if (path) this.sessionPaths.set(id, path);
    }
    if (!path) throw new Error(`Pi session ${id} was not found`);
    const snapshot = this.sessionFunctions().read(path);
    if (snapshot.id !== id) throw new Error(`Pi session ${id} resolved to mismatched history ${snapshot.id}`);
    return publicPiSessionDetail(snapshot, this.active && this.lastSessionRef === id);
  }

  async interrupt(_input: InterruptInput): Promise<void> {
    if (!this.transport?.running) return;
    this.interruptRequested = true;
    try {
      await boundedPiAbort(this.transport, 200);
    } finally {
      // Pi RPC 的 abort 只表示已接收中断，不代表进程已经退出。Issue 状态切换前
      // 必须收掉本次独占 transport，避免已取消的 Agent 继续修改工作区。
      await this.transport.stop(1000);
    }
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
    this.interruptRequested = false;
    this.lastSessionRef = sessionRef.trim();
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

  private async sessionState(transport: PiRpcTransport): Promise<{ sessionFile: string; sessionId: string; sessionRef: string } | undefined> {
    const data = await transport.send({ type: "get_state" });
    if (data && typeof data === "object" && "sessionId" in data) {
      const state = data as { sessionFile?: unknown; sessionId: unknown };
      const sessionId = String(state.sessionId ?? "");
      const sessionFile = String(state.sessionFile ?? "");
      if (sessionId && sessionFile) this.sessionPaths.set(sessionId, sessionFile);
      return { sessionFile, sessionId, sessionRef: sessionId };
    }
    return undefined;
  }

  private sessionFunctions(): PiSessionFunctions {
    return this.options.sessionFunctions ?? defaultPiSessionFunctions;
  }

  private async promptAndWait(
    transport: PiRpcTransport,
    prompt: string,
    sink: ProviderRunInput["onEvent"],
    input: { cwd?: string; projectId?: string; issueId?: number; prompt?: string }
  ): Promise<{ invocationRef: string; sessionRef: string }> {
    if (prompt.trim() === "") throw new Error("Pi RPC prompt must not be empty");
    const state = await this.sessionState(transport);
    if (!state?.sessionRef) throw new Error("pi rpc did not provide a durable session before prompt");
    this.lastSessionRef = state.sessionRef;
    const session = { provider: this.id, sessionId: state.sessionRef } as const;
    sink?.({
      provider: this.id,
      raw: { method: "pi-coding-agent/session_started" },
      runEvent: normalizedRunEvent({
        kind: "started",
        method: "pi-coding-agent/session_started",
        outcome: "running",
        provider: this.id,
        session
      }),
      session,
      status: "running",
      type: "provider.session_started"
    });
    const invocationRef = `pi-rpc-${crypto.randomUUID()}`;
    const terminal = this.waitForTerminal(transport, sink, input, state.sessionRef);
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
    input: { cwd?: string; projectId?: string; issueId?: number; prompt?: string },
    initialSessionRef: string
  ): Promise<{ sessionRef: string }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let failureReason = "";
      const activeTools = new Map<string, PiToolObservation>();
      const inactivityMs = this.options.timeoutMs ?? 30 * 60 * 1000;
      let inactivityTimeout: ReturnType<typeof setTimeout> | undefined;
      const sessionForEvent = () => {
        const sessionRef = this.lastSessionRef || initialSessionRef;
        return sessionRef ? { provider: this.id, sessionId: sessionRef } as const : undefined;
      };
      const armInactivityTimeout = () => {
        if (inactivityTimeout) clearTimeout(inactivityTimeout);
        inactivityTimeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          const error = new Error(`pi rpc agent had no activity for ${inactivityMs}ms`);
          const session = sessionForEvent();
          sink?.({
            error: error.message,
            provider: this.id,
            raw: { method: "pi-coding-agent/inactivity_timeout" },
            runEvent: normalizedRunEvent({
              kind: "error",
              method: "pi-coding-agent/inactivity_timeout",
              outcome: "failed",
              provider: this.id,
              retryable: true,
              session
            }),
            session,
            status: "failed",
            type: "provider.error"
          });
          reject(error);
        }, inactivityMs);
        inactivityTimeout.unref?.();
      };
      const cleanup = () => {
        if (inactivityTimeout) clearTimeout(inactivityTimeout);
        inactivityTimeout = undefined;
        off();
      };
      const rejectTerminal = (error: Error, method: string) => {
        if (!settled) {
          settled = true;
          cleanup();
          const session = sessionForEvent();
          sink?.({
            error: error.message,
            provider: this.id,
            raw: { method },
            runEvent: normalizedRunEvent({
              kind: "error",
              method,
              outcome: "failed",
              provider: this.id,
              session
            }),
            session,
            status: "failed",
            type: "provider.error"
          });
          reject(error);
        }
      };
      const off = transport.onEvent((event: PiRpcEvent) => {
        if (!settled) armInactivityTimeout();
        switch (event.type) {
          case "agent_settled":
            if (settled) break;
            if (this.interruptRequested) {
              settled = true;
              cleanup();
              reject(new ProviderInterruptedError("pi rpc execution was interrupted by host"));
              break;
            }
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
            if (this.interruptRequested) {
              if (!settled) {
                settled = true;
                cleanup();
                reject(new ProviderInterruptedError("pi rpc execution was interrupted by host"));
              }
              break;
            }
            rejectTerminal(
              new Error(event.type === "exit" ? "pi rpc exited before agent settled" : String(event.message ?? "pi rpc error")),
              event.type === "exit" ? "pi-coding-agent/process_exit" : "pi-coding-agent/error"
            );
            break;
          case "stderr":
            sink?.({ provider: this.id, type: "provider.error", text: String(event.text ?? "") });
            break;
          case "message_update": {
            const update = recordValue(event.assistantMessageEvent);
            if (update.type === "error") failureReason = String(update.error ?? update.reason ?? "Pi model request failed");
            if (update.type === "text_delta" && typeof update.delta === "string" && update.delta !== "") {
              const session = sessionForEvent();
              sink?.({
                provider: this.id,
                raw: { method: "item/agentMessage/delta" },
                runEvent: normalizedRunEvent({
                  kind: "progress",
                  method: "item/agentMessage/delta",
                  outcome: "running",
                  provider: this.id,
                  session
                }),
                session,
                text: update.delta,
                type: "provider.message"
              });
            }
            break;
          }
          case "tool_execution_start": {
            const observation = piToolObservation(event, input.cwd ?? "");
            if (observation) activeTools.set(observation.id, observation);
            break;
          }
          case "tool_execution_end": {
            const id = stringValue(event.toolCallId);
            const observation = activeTools.get(id);
            activeTools.delete(id);
            if (!observation) break;
            const session = sessionForEvent();
            const failed = event.isError === true;
            const output = piToolOutput(event.result);
            const exitCode = piToolExitCode(event.result, failed, output);
            const durationMs = Math.max(0, Date.now() - observation.startedAt);
            const item = {
              aggregatedOutput: output,
              command: observation.command,
              cwd: observation.cwd,
              durationMs,
              exitCode,
              id: observation.id,
              status: failed ? "failed" : "completed",
              type: "commandExecution"
            };
            sink?.({
              command: observation.command,
              payload: item,
              provider: this.id,
              raw: { method: "item/completed", payload: JSON.stringify({ item }) },
              runEvent: normalizedRunEvent({
                kind: "progress",
                method: "item/completed",
                outcome: "running",
                provider: this.id,
                session
              }),
              session,
              status: item.status,
              text: output,
              type: "tool"
            });
            break;
          }
          case "auto_retry_end":
            if (event.success === false) failureReason = String(event.finalError ?? "Pi model request failed after retries");
            break;
          default:
            break;
        }
      });
      armInactivityTimeout();
    });
  }
}

type PiToolObservation = {
  command: string;
  cwd: string;
  id: string;
  startedAt: number;
};

function piToolObservation(event: PiRpcEvent, defaultCwd: string): PiToolObservation | undefined {
  const toolName = stringValue(event.toolName).toLowerCase();
  if (toolName !== "bash") return undefined;
  const args = recordValue(event.args);
  const command = stringValue(args.command) || stringValue(args.cmd);
  const id = stringValue(event.toolCallId);
  if (command === "" || id === "") return undefined;
  return {
    command,
    cwd: stringValue(args.cwd) || defaultCwd || ".",
    id,
    startedAt: Date.now()
  };
}

function piToolOutput(value: unknown): string {
  const result = recordValue(value);
  if (!Array.isArray(result.content)) return stringValue(result.text);
  return result.content.map(recordValue).map((item) => stringValue(item.text)).filter(Boolean).join("\n");
}

function piToolExitCode(value: unknown, failed: boolean, output: string): number {
  const result = recordValue(value);
  const details = recordValue(result.details);
  if (typeof details.exitCode === "number" && Number.isSafeInteger(details.exitCode)) return details.exitCode;
  const match = output.match(/Command exited with code (\d+)/);
  if (match) return Number(match[1]);
  return failed ? 1 : 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function boundedPiAbort(transport: PiRpcTransport, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      transport.send({ type: "abort" }).then(() => undefined, () => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
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
