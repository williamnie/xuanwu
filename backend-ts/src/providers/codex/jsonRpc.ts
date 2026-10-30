import { effectiveCodexHome } from "../../config/codexServer.ts";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import type { ApprovalDecision } from "../types.ts";
import { CodexApprovalBroker } from "./approvalBroker.ts";
import { CodexProcessGroupLifecycle, type CodexProcessOwnership } from "./processLifecycle.ts";
import { managedExecutionEnvironment } from "../managedExecution.ts";
import { CodexProtocolReader } from "./jsonRpcProtocol.ts";
import { splitCommand, clearPendingTimeout, spawnCodexProcess, asError } from "./jsonRpcIO.ts";
import { type CodexJsonRpcProcess, type PendingRequest, type CodexTransportOptions, type CodexProcessLease, type JsonRpcParams, type CodexJsonRpcProcessFactory, codexAppServerRpcTimeoutMs, CODEX_PROCESS_ACTIVE_REFRESH_MS, codexIdleTtlMs } from "./jsonRpcModel.ts";

export class CodexStdioJsonRpcTransport {
  private readonly reader: CodexProtocolReader;
  private nextId = 0;
  private process?: CodexJsonRpcProcess;
  private processGeneration = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly approvals: CodexApprovalBroker;
  private readonly stderrBuffer: string[] = [];
  private readonly leases = new Map<number, { owner: string; sessionID: string; turnID: string }>();
  private readonly processLifecycle: CodexProcessGroupLifecycle;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private processActivityTimer?: ReturnType<typeof setTimeout>;
  private nextLeaseID = 0;
  private stopping?: Promise<void>;
  private stopped = false;

  constructor(private readonly config: ProviderRuntimeConfig, private readonly options: CodexTransportOptions = {}) {
    this.reader = new CodexProtocolReader({
      options, pending: this.pending, stderrBuffer: this.stderrBuffer,
      get approvals() { return transport.approvals; },
      get processLifecycle() { return transport.processLifecycle; },
      process: () => this.process,
      write: payload => this.write(payload),
      failPending: error => this.failPending(error),
      emitDiagnostic: (method, text, error) => this.emitDiagnostic(method, text, error),
      releaseSession: (sessionID, turnID) => this.releaseSession(sessionID, turnID)
    });
    const transport = this;
    this.approvals = new CodexApprovalBroker({ onEvent: (event) => this.options.onEvent?.(event) });
    this.processLifecycle = options.processLifecycle ?? new CodexProcessGroupLifecycle(
      options.ownershipFile ?? "",
      splitCommand(config.command),
      {
        onDiagnostic: ({ reason, reason_code }) => this.emitDiagnostic(
          "process/scan_failed",
          `process inspection failed (${reason_code}) during ${reason}`,
          reason_code
        )
      }
    );
  }

  async start(): Promise<void> {
    if (this.stopping) await this.stopping;
    if (this.process) return;
    this.cancelIdleStop();
    this.stopped = false;
    const spawned = (this.options.processFactory ?? spawnCodexProcess)({
      command: splitCommand(this.config.command),
      cwd: this.config.cwd.trim() || undefined,
      env: managedExecutionEnvironment({ ...Bun.env, ...this.config.env, CODEX_HOME: effectiveCodexHome(this.config) })
    });
    this.process = spawned;
    try {
      await this.processLifecycle.register(spawned);
      this.scheduleProcessActivityRefresh();
    } catch (error) {
      this.process = undefined;
      spawned.kill("SIGTERM");
      throw error;
    }
    this.reader.readStdout(this.process.stdout);
    this.reader.readStderr(this.process.stderr);
    this.watchExit(this.process);
  }

  async stop(): Promise<void> {
    if (this.stopping) return await this.stopping;
    const stopping = this.stopCurrent();
    this.stopping = stopping;
    try {
      await stopping;
    } finally {
      if (this.stopping === stopping) this.stopping = undefined;
    }
  }

  private async stopCurrent(): Promise<void> {
    this.stopped = true;
    this.cancelIdleStop();
    this.cancelProcessActivityRefresh();
    const current = this.process;
    this.process = undefined;
    if (!current) return;
    this.processGeneration += 1;
    this.failPending(new Error("codex app-server transport stopped"));
    current.stdin.end?.();
    await this.processLifecycle.stop(current);
  }

  generation(): number {
    return this.processGeneration;
  }

  acquire(owner: string): CodexProcessLease {
    const id = ++this.nextLeaseID;
    this.cancelIdleStop();
    this.leases.set(id, { owner: owner.trim(), sessionID: "", turnID: "" });
    let released = false;
    return {
      bind: (sessionID, turnID = "") => {
        if (released) return;
        const lease = this.leases.get(id);
        if (!lease) return;
        lease.sessionID = sessionID.trim();
        lease.turnID = turnID.trim();
      },
      release: () => {
        if (released) return;
        released = true;
        this.leases.delete(id);
        this.scheduleIdleStop();
      }
    };
  }

  releaseSession(sessionID: string, turnID = ""): void {
    const cleanSessionID = sessionID.trim();
    const cleanTurnID = turnID.trim();
    for (const [id, lease] of this.leases) {
      if (lease.sessionID !== cleanSessionID) continue;
      if (cleanTurnID !== "" && lease.turnID !== "" && lease.turnID !== cleanTurnID) continue;
      this.leases.delete(id);
    }
    this.scheduleIdleStop();
  }

  runtimeSnapshot(): { idle_ttl_ms: number; owners: string[]; process?: CodexProcessOwnership } {
    return {
      idle_ttl_ms: codexIdleTtlMs(this.options.idleTtlMs),
      owners: [...this.leases.values()].map((lease) => lease.owner),
      process: this.processLifecycle.snapshot()
    };
  }

  async request(method: string, params: JsonRpcParams = null): Promise<unknown> {
    this.cancelIdleStop();
    await this.start();
    const id = this.registerRequest();
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
        timeout: setTimeout(() => this.timeoutRequest(id, method), codexAppServerRpcTimeoutMs(this.config.timeoutMs))
      });
    });
    try {
      this.write({ id, method, params });
    } catch (error) {
      const pending = this.pending.get(id);
      if (!this.pending.delete(id)) return await response;
      clearPendingTimeout(pending);
      throw error;
    }
    try { return await response; }
    finally { this.scheduleIdleStop(); }
  }

  stderrLines(): string[] {
    return [...this.stderrBuffer];
  }

  async resolveApprovalRequest(requestId: string, decision: ApprovalDecision): Promise<void> {
    await this.approvals.resolveApproval(requestId, decision);
  }

  private registerRequest(): number {
    this.nextId += 1;
    return this.nextId;
  }

  private write(payload: Record<string, unknown>): void {
    const current = this.process;
    if (!current) throw new Error("codex app-server stdio transport is not started");
    current.stdin.write(`${JSON.stringify(payload)}\n`);
    current.stdin.flush?.();
  }

  private watchExit(process: CodexJsonRpcProcess): void {
    void process.exited.then((code) => {
      if (this.process !== process) return;
      this.process = undefined;
      this.processGeneration += 1;
      this.leases.clear();
      this.cancelIdleStop();
      this.cancelProcessActivityRefresh();
      this.trackExitCleanup(process);
      if (!this.stopped) this.failPending(new Error(`codex app-server exited before response (code ${code})`));
    }, (error) => {
      if (this.process !== process) return;
      this.process = undefined;
      this.processGeneration += 1;
      this.leases.clear();
      this.cancelIdleStop();
      this.cancelProcessActivityRefresh();
      this.trackExitCleanup(process);
      this.failPending(asError(error));
    });
  }

  private trackExitCleanup(process: CodexJsonRpcProcess): void {
    const cleanup = this.processLifecycle.processExited(process).catch((error) => {
      this.emitDiagnostic("process/exit_cleanup_failed", asError(error).message, asError(error).message);
    });
    this.stopping = cleanup;
    void cleanup.finally(() => {
      if (this.stopping === cleanup) this.stopping = undefined;
    });
  }

  private failPending(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    this.approvals.rejectAll(error);
    for (const request of pending) {
      clearPendingTimeout(request);
      request.reject(error);
    }
  }

  private emitDiagnostic(type: string, text: string, error?: string): void {
    this.options.onDiagnostic?.({ provider: "codex", type, text, error });
  }

  private timeoutRequest(id: number, method: string): void {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    const error = new Error(`codex app-server request timed out after ${codexAppServerRpcTimeoutMs(this.config.timeoutMs)}ms: ${method}`);
    request.reject(error);
    this.emitDiagnostic("process/timeout", error.message, error.message);
    void this.restartAfterTimeout();
  }

  private async restartAfterTimeout(): Promise<void> {
    try {
      this.leases.clear();
      await this.stop();
    } catch (error) {
      this.emitDiagnostic("process/restart_failed", asError(error).message, asError(error).message);
    }
  }

  private scheduleIdleStop(): void {
    if (!this.process || this.pending.size > 0 || this.leases.size > 0 || this.stopped) return;
    this.cancelIdleStop();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.pending.size > 0 || this.leases.size > 0 || !this.process) return;
      void this.stop().catch((error) => {
        this.emitDiagnostic("process/idle_stop_failed", asError(error).message, asError(error).message);
      });
    }, codexIdleTtlMs(this.options.idleTtlMs));
    this.idleTimer.unref?.();
  }

  private cancelIdleStop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private scheduleProcessActivityRefresh(): void {
    this.cancelProcessActivityRefresh();
    if (!this.process || this.stopped) return;
    this.processActivityTimer = setTimeout(() => {
      this.processActivityTimer = undefined;
      const process = this.process;
      if (!process || this.stopped) return;
      void this.processLifecycle.refresh(process, {
        mode: "coalesced",
        reason: "active_fallback"
      }).catch((error) => this.emitDiagnostic(
        "process/scan_failed",
        "active process topology refresh failed",
        asError(error).message
      )).finally(() => this.scheduleProcessActivityRefresh());
    }, CODEX_PROCESS_ACTIVE_REFRESH_MS);
    this.processActivityTimer.unref?.();
  }

  private cancelProcessActivityRefresh(): void {
    if (this.processActivityTimer) clearTimeout(this.processActivityTimer);
    this.processActivityTimer = undefined;
  }

}

export { type CodexProtocolHost, CodexProtocolReader } from "./jsonRpcProtocol.ts";
export { splitCommand } from "./jsonRpcIO.ts";
export { type JsonRpcParams, type CodexJsonRpcProcess, type CodexJsonRpcProcessFactory, type CodexProcessLease, codexAppServerRpcTimeoutMs } from "./jsonRpcModel.ts";
