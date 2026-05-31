import { redactSensitiveText } from "../../util/redact.ts";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import type { ProviderEvent } from "../types.ts";
import { normalizeCodexEvent } from "./events.ts";

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
};

export type CodexJsonRpcProcess = {
  stdin: { write(chunk: string | Uint8Array): unknown; flush?: () => unknown; end?: () => unknown };
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(signal?: string | number): unknown;
};

export type CodexJsonRpcProcessFactory = (options: {
  command: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
}) => CodexJsonRpcProcess;

export type ServerRequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown;
export type CodexTransportOptions = {
  onEvent?: (event: ProviderEvent) => void;
  processFactory?: CodexJsonRpcProcessFactory;
  onDiagnostic?: (event: ProviderEvent) => void;
  onServerRequest?: ServerRequestHandler;
};

const MAX_STDERR_LINES = 50;
const MAX_LINE_BYTES = 10 * 1024 * 1024;

export class CodexStdioJsonRpcTransport {
  private nextId = 0;
  private process?: CodexJsonRpcProcess;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly stderrBuffer: string[] = [];
  private stopped = false;

  constructor(private readonly config: ProviderRuntimeConfig, private readonly options: CodexTransportOptions = {}) {}

  async start(): Promise<void> {
    if (this.process) return;
    this.stopped = false;
    this.process = this.processFactory()({
      command: splitCommand(this.config.command),
      cwd: this.config.cwd.trim() || undefined,
      env: { ...Bun.env, ...this.config.env }
    });
    this.readStdout(this.process.stdout);
    this.readStderr(this.process.stderr);
    this.watchExit(this.process);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const current = this.process;
    this.process = undefined;
    if (!current) return;
    this.failPending(new Error("codex app-server transport stopped"));
    current.kill("SIGINT");
    await current.exited.catch(() => 1);
    current.stdin.end?.();
  }

  async request(method: string, params: JsonRpcParams = null): Promise<unknown> {
    await this.start();
    const id = this.registerRequest();
    const response = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    try {
      this.write({ id, method, params });
    } catch (error) {
      if (!this.pending.delete(id)) return await response;
      throw error;
    }
    return await response;
  }

  stderrLines(): string[] {
    return [...this.stderrBuffer];
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
    if (typeof message.id === "number" && typeof message.method === "string") {
      void this.deliverServerRequest(message.id, message.method, message.params);
      return;
    }
    if (typeof message.id === "number") this.deliverResponse(message.id, message);
    if (typeof message.method === "string" && message.id === undefined) this.deliverEvent(message.method, message.params);
  }

  private async deliverServerRequest(id: number, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.serverRequestResult(method, params);
      this.write({ id, result });
    } catch (error) {
      this.write({ id, error: { code: -32603, message: asError(error).message } });
    }
  }

  private async serverRequestResult(method: string, params: unknown): Promise<unknown> {
    if (this.options.onServerRequest) return await this.options.onServerRequest(method, params);
    if (method === "item/tool/requestUserInput") return { answers: {} };
    if (method === "mcpServer/elicitation/request") return { action: "cancel", content: null, _meta: null };
    if (method === "item/tool/call") return { contentItems: [], success: false };
    throw new Error(`unsupported server request: ${method}`);
  }

  private deliverEvent(method: string, params: unknown): void {
    this.options.onEvent?.(normalizeCodexEvent({ method, params }));
  }

  private deliverResponse(id: number, message: JsonRpcResponse): void {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
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
      if (!this.stopped) this.failPending(new Error(`codex app-server exited before response (code ${code})`));
    }, (error) => {
      if (this.process === process) this.failPending(asError(error));
    });
  }

  private failPending(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) request.reject(error);
  }

  private emitDiagnostic(type: string, text: string, error?: string): void {
    this.options.onDiagnostic?.({ provider: "codex", type, text, error });
  }
}

export async function runCodexTransportInitializeSmoke(
  config: ProviderRuntimeConfig,
  options: CodexTransportOptions = {}
): Promise<unknown> {
  const transport = new CodexStdioJsonRpcTransport(config, options);
  try {
    return await transport.request("initialize", {
      clientInfo: { name: "codex-issue-runner-bun", version: "0.1.0" },
      capabilities: { experimentalApi: true }
    });
  } finally {
    await transport.stop();
  }
}

function spawnCodexProcess({ command, cwd, env }: {
  command: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
}): CodexJsonRpcProcess {
  return Bun.spawn(command, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
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
