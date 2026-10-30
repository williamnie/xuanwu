import type { SessionReadInput, SessionTurnsListInput, SessionTurnsListResult } from "../types.ts";
import { type ApprovalDecision, type ExecutorCapability, type ExecutorProvider, type InterruptInput, type ProviderRecoveryInput, type ProviderRunInput, type ProviderRunResult, type ProviderRuntimeStatus, type SessionCreateInput, type SessionCreateResult, type SessionMessageInput, type SessionMessageResult } from "../types.ts";
import { resolve } from "node:path";
import { PiRpcTransport } from "./rpcTransport.ts";
import { detectProviderCommand } from "../core/command.ts";
import { providerSessionStartedEvent } from "../core/sessionLifecycle.ts";
import { defaultPiSessionFunctions, publicPiSessionDetail, piTranscriptTurns, type PiSessionFunctions } from "./sessionHistory.ts";
import { PiPolicyApprovals } from "./policyApprovals.ts";
import { waitForPiTerminal } from "./terminalObserver.ts";
import { type PiExecutorProviderOptions, assertPiLegacyPolicy, piNativeExecution, applyExecutionSettings, assertPiApprovalPolicy, boundedPiAbort, normalizeModel, piVersion } from "./providerSettings.ts";

export class PiExecutorProvider implements ExecutorProvider {
  readonly id = "pi-coding-agent" as const;
  readonly capabilities: readonly ExecutorCapability[] = ["issue_execution", "sessions", "resume_session", "interrupt", "approvals", "model_list"];
  readonly interruptScope = "active" as const;
  private transport?: PiRpcTransport;
  private transportCwd = "";
  private active = false;
  private interruptRequested = false;
  private lastSessionRef = "";
  private readonly sessionPaths = new Map<string, string>();
  private readonly approvals = new PiPolicyApprovals();

  constructor(private readonly options: PiExecutorProviderOptions = {}) {
    this.transport = options.transport;
  }

  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    assertPiLegacyPolicy(input);
    const native = piNativeExecution(input, this.options.policyExtensionPath);
    const transport = await this.beginOperation(input.cwd, "", native.tools, native.extensions);
    try {
      await transport.send({ type: "new_session" });
      await applyExecutionSettings(transport, input.model, input.reasoningEffort);
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
    assertPiLegacyPolicy(input);
    const native = piNativeExecution(input, this.options.policyExtensionPath);
    const transport = await this.beginOperation(input.cwd, input.session.sessionId, native.tools, native.extensions);
    try {
      await applyExecutionSettings(transport, input.model, input.reasoningEffort);
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
    if (!input.policy) assertPiApprovalPolicy(input.approvalPolicy);
    const native = piNativeExecution(input, this.options.policyExtensionPath);
    const transport = await this.beginOperation(input.cwd, "", native.tools, native.extensions);
    try {
      await transport.send({ type: "new_session" });
      await applyExecutionSettings(transport, input.model, input.reasoningEffort);
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

  private async sessionPath(sessionId: string): Promise<string> {
    const id = sessionId.trim();
    if (id === "") throw new Error("Pi session id is required");
    let path = this.sessionPaths.get(id);
    if (!path) {
      path = await this.sessionFunctions().resolve(id);
      if (path) this.sessionPaths.set(id, path);
    }
    if (!path) throw new Error(`Pi session ${id} was not found`);
    return path;
  }

  async readSession(sessionId: string, input: SessionReadInput = {}): Promise<Record<string, unknown>> {
    const id = sessionId.trim();
    const snapshot = await this.sessionFunctions().read(await this.sessionPath(id), input);
    if (snapshot.id !== id) throw new Error(`Pi session ${id} resolved to mismatched history ${snapshot.id}`);
    const detail = publicPiSessionDetail(snapshot, this.active && this.lastSessionRef === id);
    return input.includeTurns === false ? { ...detail, turns: [] } : detail;
  }

  async listSessionTurns(sessionId: string, input: SessionTurnsListInput): Promise<SessionTurnsListResult> {
    const id = sessionId.trim();
    const readTurns = this.sessionFunctions().readTurns;
    if (readTurns) {
      const page = await readTurns(await this.sessionPath(id), input);
      if (page.id !== id) throw new Error(`Pi session ${id} resolved to mismatched history ${page.id}`);
      return { data: page.groups.flatMap(piTranscriptTurns), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    }
    const detail = await this.readSession(id, { includeTurns: true });
    const turns = detail.turns as Array<Record<string, unknown>>;
    const ordered = input.sortDirection === "asc" ? turns : [...turns].reverse();
    const offset = /^\d+$/.test(input.cursor || "") ? Number(input.cursor) : 0;
    const limit = input.limit || 20;
    return { data: ordered.slice(offset, offset + limit), ...(offset + limit < ordered.length ? { nextCursor: String(offset + limit) } : {}) };
  }

  async interrupt(_input: InterruptInput): Promise<void> {
    await this.approvals.rejectPendingApprovals("Pi invocation interrupted while approval was pending");
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
    if (!input.policy) assertPiApprovalPolicy(input.approvalPolicy);
    const native = piNativeExecution(input, this.options.policyExtensionPath);
    const transport = await this.beginOperation(input.cwd, input.sessionId, native.tools, native.extensions);
    try {
      await applyExecutionSettings(transport, input.model, input.reasoningEffort);
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
    await this.approvals.rejectPendingApprovals("Pi provider stopped while approval was pending");
    await this.transport?.stop();
  }

  async resolveApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    await this.approvals.resolveApproval(requestId, decision);
  }

  processLeases() {
    const lease = this.transport?.processLease();
    return lease ? [lease] : [];
  }

  private async beginOperation(cwd = "", sessionRef = "", tools: readonly string[] = [], extensions: readonly string[] = []): Promise<PiRpcTransport> {
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
      await this.transport.startForSession(sessionRef, tools, extensions);
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
    input: Pick<ProviderRunInput, "cwd" | "projectId" | "issueId" | "prompt" | "policy">
  ): Promise<{ invocationRef: string; sessionRef: string }> {
    if (prompt.trim() === "") throw new Error("Pi RPC prompt must not be empty");
    const state = await this.sessionState(transport);
    if (!state?.sessionRef) throw new Error("pi rpc did not provide a durable session before prompt");
    this.lastSessionRef = state.sessionRef;
    sink?.(providerSessionStartedEvent(this.id, state.sessionRef, {
      method: "pi-coding-agent/session_started"
    }));
    const invocationRef = `pi-rpc-${crypto.randomUUID()}`;
    const terminal = waitForPiTerminal({
      id: this.id,
      timeoutMs: this.options.timeoutMs,
      lastSessionRef: () => this.lastSessionRef,
      interrupted: () => this.interruptRequested,
      sessionState: value => this.sessionState(value),
      rejectPendingApprovals: reason => this.approvals.rejectPendingApprovals(reason),
      handlePolicyApprovalRequest: (...args) => this.approvals.handlePolicyApprovalRequest(...args)
    }, transport, sink, input, state.sessionRef, invocationRef);
    try {
      await transport.send({ id: invocationRef, type: "prompt", message: prompt });
      return { invocationRef, ...await terminal };
    } catch (error) {
      await transport.stop().catch(() => {});
      await terminal.catch(() => {});
      throw error;
    }
  }

  /**
   * 等待 authoritative terminal：`agent_settled`（fully settled）。
   * 事件流同时转发给 runner（provider.message / provider.error）。
   */

}

export { PiPolicyApprovals } from "./policyApprovals.ts";
export { type PiTerminalHost, waitForPiTerminal } from "./terminalObserver.ts";
export { type PiExecutorProviderOptions, applyExecutionSettings } from "./providerSettings.ts";
