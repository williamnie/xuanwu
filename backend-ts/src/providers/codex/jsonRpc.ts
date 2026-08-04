import { redactSensitiveText } from "../../util/redact.ts";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import type { ApprovalDecision, ProviderEvent } from "../types.ts";
import { CodexApprovalBroker } from "./approvalBroker.ts";
import { normalizeCodexEvent } from "./events.ts";
import { CodexProcessGroupLifecycle, type CodexProcessOwnership } from "./processLifecycle.ts";
import { managedExecutionEnvironment } from "../managedExecution.ts";

export type JsonRpcParams = Record<string, unknown> | unknown[] | null;

type JsonRpcResponse = {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown } | null;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
};

export type CodexJsonRpcProcess = {
  stdin: { write(chunk: string | Uint8Array): unknown; flush?: () => unknown; end?: () => unknown };
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(signal?: string | number): unknown;
  pid?: number;
};

export type CodexJsonRpcProcessFactory = (options: {
  command: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
}) => CodexJsonRpcProcess;

export type ServerRequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown;
export type CodexTransportOptions = {
  idleTtlMs?: number;
  onEvent?: (event: ProviderEvent) => void;
  ownershipFile?: string;
  processFactory?: CodexJsonRpcProcessFactory;
  processLifecycle?: CodexProcessGroupLifecycle;
  onDiagnostic?: (event: ProviderEvent) => void;
  onServerRequest?: ServerRequestHandler;
};

export type CodexProcessLease = {
  bind(sessionID: string, turnID?: string): void;
  release(): void;
};

const MAX_STDERR_LINES = 50;
const MAX_LINE_BYTES = 10 * 1024 * 1024;
export const CODEX_APP_SERVER_RPC_TIMEOUT_MS = 90_000;
export const CODEX_APP_SERVER_IDLE_TTL_MS = 15_000;

export class CodexStdioJsonRpcTransport {
  private nextId = 0;
  private process?: CodexJsonRpcProcess;
  private processGeneration = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly approvals: CodexApprovalBroker;
  private readonly stderrBuffer: string[] = [];
  private readonly leases = new Map<number, { owner: string; sessionID: string; turnID: string }>();
  private readonly processLifecycle: CodexProcessGroupLifecycle;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private nextLeaseID = 0;
  private stopping?: Promise<void>;
  private stopped = false;

  constructor(private readonly config: ProviderRuntimeConfig, private readonly options: CodexTransportOptions = {}) {
    this.approvals = new CodexApprovalBroker({ onEvent: (event) => this.options.onEvent?.(event) });
    this.processLifecycle = options.processLifecycle ?? new CodexProcessGroupLifecycle(
      options.ownershipFile ?? "",
      splitCommand(config.command)
    );
  }

  async start(): Promise<void> {
    if (this.stopping) await this.stopping;
    if (this.process) return;
    this.cancelIdleStop();
    this.stopped = false;
    const spawned = this.processFactory()({
      command: splitCommand(this.config.command),
      cwd: this.config.cwd.trim() || undefined,
      env: managedExecutionEnvironment({ ...Bun.env, ...this.config.env })
    });
    this.process = spawned;
    try {
      await this.processLifecycle.register(spawned);
    } catch (error) {
      this.process = undefined;
      spawned.kill("SIGTERM");
      throw error;
    }
    this.readStdout(this.process.stdout);
    this.readStderr(this.process.stderr);
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
      idle_ttl_ms: this.idleTtlMs(),
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
        timeout: setTimeout(() => this.timeoutRequest(id, method), this.requestTimeoutMs())
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
    try {
      return await response;
    } finally {
      void this.processLifecycle.refresh(this.process as CodexJsonRpcProcess).catch(() => {});
      this.scheduleIdleStop();
    }
  }

  stderrLines(): string[] {
    return [...this.stderrBuffer];
  }

  async resolveApprovalRequest(requestId: string, decision: ApprovalDecision): Promise<void> {
    await this.approvals.resolveApproval(requestId, decision);
  }

  private processFactory(): CodexJsonRpcProcessFactory {
    return this.options.processFactory ?? spawnCodexProcess;
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

  private readStdout(stream: ReadableStream<Uint8Array> | null): void {
    if (!stream) return;
    void readLines(stream, (line) => this.handleStdoutLine(line), (error) => this.failPending(error));
  }

  private readStderr(stream: ReadableStream<Uint8Array> | null): void {
    if (!stream) return;
    void readLines(stream, (line) => this.captureStderrLine(line));
  }

  private handleStdoutLine(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch (error) {
      this.emitDiagnostic("protocol/error", redactSensitiveText(line), asError(error).message);
      return;
    }
    if (isRequestId(message.id) && typeof message.method === "string") {
      void this.deliverServerRequest(message.id, message.method, message.params);
      return;
    }
    if (typeof message.id === "number") this.deliverResponse(message.id, message);
    if (typeof message.method === "string" && message.id === undefined) this.deliverEvent(message.method, message.params);
  }

  private async deliverServerRequest(id: string | number, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.serverRequestResult(method, params, id);
      this.write({ id, result });
    } catch (error) {
      this.write({ id, error: { code: -32603, message: asError(error).message } });
    }
  }

  private async serverRequestResult(method: string, params: unknown, id: string | number = 0): Promise<unknown> {
    if (this.approvals.canHandle(method)) return await this.approvals.request(id, method, params);
    if (this.options.onServerRequest) return await this.options.onServerRequest(method, params);
    if (method === "item/tool/requestUserInput") return { answers: {} };
    if (method === "mcpServer/elicitation/request") return { action: "cancel", content: null, _meta: null };
    if (method === "item/tool/call") return { contentItems: [], success: false };
    throw new Error(`unsupported server request: ${method}`);
  }

  private deliverEvent(method: string, params: unknown): void {
    const event = normalizeCodexEvent({ method, params });
    void this.processLifecycle.refresh(this.process as CodexJsonRpcProcess).catch(() => {});
    if (event.runEvent?.terminal && event.session?.sessionId) {
      this.releaseSession(event.session.sessionId, event.session.turnId);
    }
    this.options.onEvent?.(event);
  }

  private deliverResponse(id: number, message: JsonRpcResponse): void {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    clearPendingTimeout(request);
    if (message.error) {
      request.reject(new Error(`codex rpc ${String(message.error.code ?? "error")}: ${String(message.error.message ?? "unknown error")}`));
      return;
    }
    request.resolve(message.result);
  }

  private captureStderrLine(line: string): void {
    const text = redactSensitiveText(line);
    this.stderrBuffer.push(text);
    if (this.stderrBuffer.length > MAX_STDERR_LINES) this.stderrBuffer.shift();
    this.emitDiagnostic("process/stderr", text, text);
  }

  private watchExit(process: CodexJsonRpcProcess): void {
    void process.exited.then((code) => {
      if (this.process !== process) return;
      this.process = undefined;
      this.processGeneration += 1;
      this.leases.clear();
      this.cancelIdleStop();
      void this.processLifecycle.processExited(process).catch(() => {});
      if (!this.stopped) this.failPending(new Error(`codex app-server exited before response (code ${code})`));
    }, (error) => {
      if (this.process !== process) return;
      this.process = undefined;
      this.processGeneration += 1;
      this.leases.clear();
      this.cancelIdleStop();
      void this.processLifecycle.processExited(process).catch(() => {});
      this.failPending(asError(error));
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

  private requestTimeoutMs(): number {
    return codexAppServerRpcTimeoutMs(this.config.timeoutMs);
  }

  private timeoutRequest(id: number, method: string): void {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    const error = new Error(`codex app-server request timed out after ${this.requestTimeoutMs()}ms: ${method}`);
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
    }, this.idleTtlMs());
    this.idleTimer.unref?.();
  }

  private cancelIdleStop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private idleTtlMs(): number {
    const configured = this.options.idleTtlMs;
    return typeof configured === "number" && Number.isFinite(configured) && configured >= 0
      ? configured
      : CODEX_APP_SERVER_IDLE_TTL_MS;
  }
}

function clearPendingTimeout(request: PendingRequest | undefined): void {
  if (request?.timeout) clearTimeout(request.timeout);
}

export function codexAppServerRpcTimeoutMs(configuredTimeoutMs: number): number {
  return Math.min(Math.max(1, configuredTimeoutMs), CODEX_APP_SERVER_RPC_TIMEOUT_MS);
}

export async function runCodexTransportInitializeSmoke(
  config: ProviderRuntimeConfig,
  options: CodexTransportOptions = {}
): Promise<unknown> {
  const transport = new CodexStdioJsonRpcTransport(config, options);
  try {
    return await transport.request("initialize", {
      clientInfo: { name: "xuanwu", version: "0.1.0" },
      capabilities: { experimentalApi: true }
    });
  } finally {
    await transport.stop();
  }
}

function isRequestId(value: unknown): value is string | number {
  return typeof value === "number" || typeof value === "string";
}

function spawnCodexProcess({ command, cwd, env }: {
  command: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
}): CodexJsonRpcProcess {
  return Bun.spawn(command, { cwd, detached: true, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
}

export function splitCommand(command: string): string[] {
  const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(unquoteArg) ?? [];
  if (parts.length === 0) throw new Error("codex command is empty");
  return parts;
}

function unquoteArg(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
  onError?: (error: Error) => void
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = drainLines(buffer, onLine);
      if (buffer.length > MAX_LINE_BYTES) throw new Error("codex app-server stdout frame exceeds limit");
    }
    buffer += decoder.decode();
    if (buffer.trim() !== "") onLine(buffer);
  } catch (error) {
    onError?.(asError(error));
  } finally {
    reader.releaseLock();
  }
}

function drainLines(buffer: string, onLine: (line: string) => void): string {
  let start = 0;
  while (true) {
    const index = buffer.indexOf("\n", start);
    if (index < 0) return buffer.slice(start);
    const line = buffer.slice(start, index).replace(/\r$/, "");
    if (line.trim() !== "") onLine(line);
    start = index + 1;
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
