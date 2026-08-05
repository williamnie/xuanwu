import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/**
 * P10：Pi Coding Agent RPC transport（G10 调研：pi 0.83.0，JSON lines over stdio）。
 * 协议（dist/modes/rpc/rpc-types.d.ts）：
 * - command：{ type, id?, ... } JSON line on stdin；
 * - response：{ id?, type: "response", command, success, data|error }，按 id 关联请求；
 * - events：AgentSessionEvent JSON lines on stdout（agent_start/agent_end/agent_settled/turn_start/turn_end/...）。
 */

export type PiRpcCommand =
  | { id?: string; type: "prompt"; message: string; streamingBehavior?: "steer" | "followUp" }
  | { id?: string; type: "steer"; message: string }
  | { id?: string; type: "follow_up"; message: string }
  | { id?: string; type: "abort" }
  | { id?: string; type: "new_session"; parentSession?: string }
  | { id?: string; type: "get_state" }
  | { id?: string; type: "get_available_models" }
  | { id?: string; type: "set_model"; provider: string; modelId: string }
  | { id?: string; type: "switch_session"; sessionPath: string }
  | { id?: string; type: "set_thinking_level"; level: string };

export type PiRpcResponse = {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: unknown;
};

export type PiRpcEvent = { type: string; [key: string]: unknown };

export type PiRpcEventSink = (event: PiRpcEvent) => void;

const RESPONSE_PATTERN = /^\{.*"type"\s*:\s*"response"/;

export type PiRpcTransportOptions = {
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  sessionRef?: string;
  timeoutMs?: number;
};

export class PiRpcTransport {
  private process?: ChildProcess;
  private readonly pending = new Map<string, {
    reject: (error: Error) => void;
    resolve: (data: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly eventSinks = new Set<PiRpcEventSink>();
  private readonly decoder = new StringDecoder("utf8");
  private stdoutBuffer = "";
  private seq = 0;
  private startedAt = "";
  private startupSessionRef = "";
  private startupTools: string[] = [];
  private readonly options: Required<Pick<PiRpcTransportOptions, "command" | "timeoutMs">> & PiRpcTransportOptions;

  constructor(options: string | PiRpcTransportOptions = "pi") {
    const normalized = typeof options === "string" ? { command: options } : options;
    this.options = {
      ...normalized,
      command: normalized.command?.trim() || "pi",
      timeoutMs: positiveTimeout(normalized.timeoutMs, 30_000)
    };
    this.startupSessionRef = normalized.sessionRef?.trim() ?? "";
  }

  onEvent(sink: PiRpcEventSink): () => void {
    this.eventSinks.add(sink);
    return () => this.eventSinks.delete(sink);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.stdoutBuffer = "";
    const [executable, ...configuredArgs] = splitCommand(this.options.command);
    if (!executable) throw new Error("pi rpc command is empty");
    const sessionArgs = this.startupSessionRef ? ["--session", this.startupSessionRef] : [];
    const toolArgs = this.startupTools.length > 0 ? ["--tools", this.startupTools.join(",")] : [];
    this.process = spawn(executable, [...configuredArgs, ...sessionArgs, ...toolArgs, "--mode", "rpc"], {
      cwd: this.options.cwd?.trim() || undefined,
      env: piRpcChildEnv(globalThis.process.env, this.options.env),
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.startedAt = new Date().toISOString();
    this.process.stdout!.on("data", (chunk: Buffer | string) => this.handleStdout(chunk));
    this.process.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text !== "") this.emit({ type: "stderr", text });
    });
    this.process.on("error", (error) => {
      this.rejectAll(new Error(`pi rpc failed to start: ${error.message}`));
      this.emit({ type: "error", message: error.message });
    });
    this.process.on("exit", (code, signal) => {
      this.rejectAll(new Error(`pi rpc exited (code=${code ?? ""} signal=${signal ?? ""})`));
      this.emit({ type: "exit", code, signal });
    });
  }

  async startForSession(sessionRef = "", tools: readonly string[] = []): Promise<void> {
    const normalized = sessionRef.trim();
    const normalizedTools = [...tools].map((tool) => tool.trim()).filter(Boolean);
    if (this.running && normalized === this.startupSessionRef && normalizedTools.join(",") === this.startupTools.join(",")) return;
    if (this.running) await this.stop();
    this.startupSessionRef = normalized;
    this.startupTools = normalizedTools;
    await this.start();
  }

  async stop(): Promise<void> {
    const child = this.process;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async send(command: PiRpcCommand): Promise<unknown> {
    if (!this.process || this.process.exitCode !== null) {
      throw new Error("pi rpc transport is not running");
    }
    const id = command.id ?? `cmd-${++this.seq}`;
    const payload = { ...command, id };
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi rpc command ${command.type} timed out after ${this.options.timeoutMs}ms`));
      }, this.options.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process!.stdin!.write(JSON.stringify(payload) + "\n", (error) => {
        if (error) {
          const pending = this.pending.get(id);
          if (pending) clearTimeout(pending.timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  get running(): boolean {
    return Boolean(this.process && this.process.exitCode === null);
  }

  processLease(): { commandLabel: string; invocationOwner: string; pgid?: number; pid: number; startedAt: string } | undefined {
    const pid = this.process?.pid;
    if (!this.running || !pid) return undefined;
    return {
      commandLabel: "pi --mode rpc",
      invocationOwner: "pi-coding-agent:rpc",
      pgid: pid,
      pid,
      startedAt: this.startedAt
    };
  }

  private handleStdout(chunk: Buffer | string): void {
    this.stdoutBuffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      let line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.emit({ type: "unparseable", line: trimmed.slice(0, 500) });
      return;
    }
    const record = parsed as Record<string, unknown>;
    if (RESPONSE_PATTERN.test(trimmed) || record.type === "response") {
      this.handleResponse(record as unknown as PiRpcResponse);
      return;
    }
    this.emit(record as unknown as PiRpcEvent);
  }

  private handleResponse(response: PiRpcResponse): void {
    const id = typeof response.id === "string" ? response.id : "";
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (response.success) pending.resolve(response.data);
    else pending.reject(new Error(describeError(response.error)));
  }

  private emit(event: PiRpcEvent): void {
    for (const sink of [...this.eventSinks]) {
      try {
        sink(event);
      } catch {
        // 事件消费者异常不阻塞 transport
      }
    }
  }

  protected emitEvent(event: PiRpcEvent): void {
    for (const sink of [...this.eventSinks]) {
      try {
        sink(event);
      } catch {
        // 事件消费者异常不阻塞 transport
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }
}

/**
 * `PI_PACKAGE_DIR` points Xuanwu's compiled binary at its colocated SDK assets.
 * An external `pi` CLI must resolve assets from its own installation instead;
 * inheriting Xuanwu's directory mixes two package layouts/versions and crashes
 * before RPC startup. An explicit Provider env override remains authoritative.
 */
export function piRpcChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  overrides?: Record<string, string>
): NodeJS.ProcessEnv {
  const env = { ...parentEnv };
  if (!Object.prototype.hasOwnProperty.call(overrides ?? {}, "PI_PACKAGE_DIR")) {
    delete env.PI_PACKAGE_DIR;
  }
  return { ...env, ...overrides };
}

function splitCommand(command: string): string[] {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((value) => {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }
    return value;
  }) ?? [];
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return "pi rpc command failed";
}
