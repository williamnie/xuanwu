import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

/**
 * P10：Pi Coding Agent RPC transport（G10 调研：pi 0.83.0，JSON lines over stdio）。
 * 协议（dist/modes/rpc/rpc-types.d.ts）：
 * - command：{ type, id?, ... } JSON line on stdin；
 * - response：{ type: "response", command, success, data|error }；
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
  | { id?: string; type: "set_thinking_level"; level: string };

export type PiRpcResponse = {
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: unknown;
};

export type PiRpcEvent = { type: string; [key: string]: unknown };

export type PiRpcEventSink = (event: PiRpcEvent) => void;

const RESPONSE_PATTERN = /^\{.*"type"\s*:\s*"response"/;

export class PiRpcTransport {
  private process?: ChildProcess;
  private lines?: Interface;
  private readonly pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void }>();
  private readonly eventSinks = new Set<PiRpcEventSink>();
  private seq = 0;
  private stopped = false;

  constructor(private readonly command = "pi") {}

  onEvent(sink: PiRpcEventSink): () => void {
    this.eventSinks.add(sink);
    return () => this.eventSinks.delete(sink);
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.process = spawn(this.command, ["rpc"], { stdio: ["pipe", "pipe", "pipe"] });
    this.lines = createInterface({ input: this.process.stdout!, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.handleLine(line));
    this.process.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text !== "") this.emit({ type: "stderr", text });
    });
    this.process.on("exit", (code, signal) => {
      this.rejectAll(new Error(`pi rpc exited (code=${code ?? ""} signal=${signal ?? ""})`));
      this.emit({ type: "exit", code, signal });
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
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
      this.pending.set(id, { resolve, reject });
      this.process!.stdin!.write(JSON.stringify(payload) + "\n", (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  get running(): boolean {
    return Boolean(this.process && this.process.exitCode === null);
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
    const id = typeof response.command === "string" ? response.command : "";
    // response.command 是原 command id；若无匹配则尝试忽略
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
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
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}

function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return "pi rpc command failed";
}
