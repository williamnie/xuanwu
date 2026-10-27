import { realpath, stat } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { NodeInfo } from "../db/repositories/nodes.ts";
import {
  NODE_HELLO_PATH,
  NODE_MESSAGES_MAX_BATCH,
  NODE_MESSAGES_PATH,
  NODE_PROTOCOL_VERSION,
  NODE_STREAM_IDLE_MS,
  NODE_STREAM_PATH,
  type NodeCommand,
  type NodeEventMessage,
  type NodeHelloResponse,
  type NodeResponseMessage
} from "./protocol.ts";

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** 每次运行未确认事件的上限；超出后丢弃最旧的事件，中心按 seq 缺口感知。 */
const RUN_EVENT_BUFFER_LIMIT = 4_096;
const FLUSH_RETRY_MS = 2_000;

export type NodeCommandHandler = (params: unknown, agent: NodeAgent) => Promise<unknown>;

export type NodeAgentOptions = {
  allowedRoots: string[];
  fetch?: typeof fetch;
  handlers?: Record<string, NodeCommandHandler>;
  hubUrl: string;
  /** 每次握手时读取，provider 就绪状态可能在运行期变化。 */
  info?: () => Omit<NodeInfo, "allowed_roots">;
  log?: (event: Record<string, unknown>) => void;
  token: string;
};

/** 节点不可恢复的错误（密钥无效、协议不兼容），重连无意义。 */
export class NodeAgentFatalError extends Error {
  override readonly name = "NodeAgentFatalError";
}

/**
 * 节点端：握手 → 打开 SSE 下行通道接收指令 → 经 POST 上报响应与运行事件。
 * 断线后指数退避重连；未确认的运行事件保留在内存中，重连后补发。
 */
export class NodeAgent {
  readonly allowedRoots: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly handlers: Record<string, NodeCommandHandler>;
  private readonly hubUrl: string;
  private readonly log: (event: Record<string, unknown>) => void;
  private readonly responses: NodeResponseMessage[] = [];
  private readonly runEvents = new Map<string, { finished: boolean; nextSeq: number; pending: NodeEventMessage[] }>();
  private flushing: Promise<void> | undefined;
  private flushAgain = false;
  private flushRetry: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly abort = new AbortController();

  constructor(private readonly options: NodeAgentOptions) {
    this.allowedRoots = options.allowedRoots.map((root) => resolve(root));
    this.fetchImpl = options.fetch ?? fetch;
    this.handlers = { ...builtinHandlers, ...options.handlers };
    this.hubUrl = options.hubUrl.replace(/\/+$/, "");
    this.log = options.log ?? ((event) => console.info(JSON.stringify(event)));
  }

  /** 持续运行直到 stop() 或遇到不可恢复错误。 */
  async run(): Promise<void> {
    let backoff = RECONNECT_MIN_MS;
    while (!this.stopped) {
      try {
        const hello = await this.hello();
        this.log({ event: "node.connected", name: hello.name, node_id: hello.node_id, private_network: hello.private_network });
        if (!hello.private_network) {
          this.log({ event: "node.public_network_warning", message: "hub sees this node on a non-private address; use Tailscale or another private network" });
        }
        backoff = RECONNECT_MIN_MS;
        void this.flush();
        await this.consumeStream();
      } catch (error) {
        if (error instanceof NodeAgentFatalError || this.stopped) {
          if (!this.stopped) throw error;
          return;
        }
        this.log({ event: "node.disconnected", error: error instanceof Error ? error.message : String(error), retry_ms: backoff });
      }
      if (this.stopped) return;
      await sleep(backoff, this.abort.signal);
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    }
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.flushRetry);
    this.abort.abort();
  }

  /** 供命令处理器上报某次运行的事件；seq 在节点内按 runRef 单调递增。 */
  emitRunEvent(runRef: string, event: unknown): void {
    const run = this.runEvents.get(runRef) ?? { finished: false, nextSeq: 1, pending: [] };
    this.runEvents.set(runRef, run);
    run.pending.push({ type: "event", runRef, seq: run.nextSeq, event });
    run.nextSeq += 1;
    if (run.pending.length > RUN_EVENT_BUFFER_LIMIT) run.pending.shift();
    void this.flush();
  }

  /** 标记运行已发出最后一个事件；全部确认后释放缓冲。 */
  finishRun(runRef: string): void {
    const run = this.runEvents.get(runRef);
    if (!run) return;
    run.finished = true;
    if (run.pending.length === 0) this.runEvents.delete(runRef);
  }

  /** cwd 必须解析（含符号链接）后落在某个 allowedRoot 之内。 */
  async resolveAllowedPath(path: string): Promise<string> {
    if (typeof path !== "string" || !isAbsolute(path)) throw new Error("path must be absolute");
    const real = await realpath(path);
    for (const root of this.allowedRoots) {
      const realRoot = await realpath(root).catch(() => "");
      if (realRoot === "") continue;
      if (isWithin(realRoot, real)) return real;
    }
    throw new Error("path is outside the node's allowed roots");
  }

  private async hello(): Promise<NodeHelloResponse> {
    const info = this.options.info?.() ?? { hostname: osHostname(), os: process.platform, providers: [], version: "" };
    const response = await this.post(NODE_HELLO_PATH, { ...info, allowed_roots: this.allowedRoots, protocol: NODE_PROTOCOL_VERSION });
    return await response.json() as NodeHelloResponse;
  }

  private async consumeStream(): Promise<void> {
    const idle = new AbortController();
    const signal = AbortSignal.any([this.abort.signal, idle.signal]);
    let idleTimer = setTimeout(() => idle.abort(), NODE_STREAM_IDLE_MS);
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idle.abort(), NODE_STREAM_IDLE_MS);
    };
    try {
      const response = await this.fetchImpl(`${this.hubUrl}${NODE_STREAM_PATH}`, { headers: this.headers(), signal });
      await assertOk(response);
      if (!response.body) throw new Error("hub stream has no body");
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body) {
        resetIdle();
        buffer += decoder.decode(chunk, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          this.handleFrame(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
        }
      }
      throw new Error("hub stream ended");
    } catch (error) {
      if (idle.signal.aborted && !this.abort.signal.aborted) throw new Error("hub stream idle timeout");
      throw error;
    } finally {
      clearTimeout(idleTimer);
    }
  }

  private handleFrame(frame: string): void {
    const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (data === "") return;
    let command: NodeCommand;
    try {
      command = JSON.parse(data) as NodeCommand;
    } catch {
      this.log({ event: "node.invalid_command_frame" });
      return;
    }
    void this.dispatch(command);
  }

  private async dispatch(command: NodeCommand): Promise<void> {
    const handler = this.handlers[command.method];
    try {
      if (!handler) throw new Error(`unknown method: ${command.method}`);
      this.responses.push({ type: "res", id: command.id, ok: true, result: await handler(command.params, this) });
    } catch (error) {
      this.responses.push({ type: "res", id: command.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    await this.flush();
  }

  /** 串行上报：同一时刻只有一个 POST，期间到达的消息在本轮结束后再发一轮。 */
  private flush(): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true;
      return this.flushing;
    }
    this.flushing = (async () => {
      try {
        do {
          this.flushAgain = false;
          await this.flushOnce();
        } while (this.flushAgain && !this.stopped);
      } catch (error) {
        // 留在队列里定时重发；新消息或重连也会触发重发。
        this.log({ event: "node.flush_failed", error: error instanceof Error ? error.message : String(error) });
        if (!this.stopped && this.flushRetry === undefined) {
          this.flushRetry = setTimeout(() => {
            this.flushRetry = undefined;
            void this.flush();
          }, FLUSH_RETRY_MS);
        }
      } finally {
        this.flushing = undefined;
      }
    })();
    return this.flushing;
  }

  private async flushOnce(): Promise<void> {
    while (this.responses.length > 0 || this.hasPendingEvents()) {
      const responses = this.responses.slice(0, NODE_MESSAGES_MAX_BATCH);
      const events = this.pendingEvents(NODE_MESSAGES_MAX_BATCH - responses.length);
      const response = await this.post(NODE_MESSAGES_PATH, { messages: [...responses, ...events] });
      const body = await response.json() as { acks?: Record<string, number> };
      this.responses.splice(0, responses.length);
      for (const [runRef, seq] of Object.entries(body.acks ?? {})) {
        const run = this.runEvents.get(runRef);
        if (!run) continue;
        run.pending = run.pending.filter((event) => event.seq > seq);
        if (run.finished && run.pending.length === 0) this.runEvents.delete(runRef);
      }
      if (events.length > 0 && Object.keys(body.acks ?? {}).length === 0) return;
    }
  }

  private hasPendingEvents(): boolean {
    for (const run of this.runEvents.values()) if (run.pending.length > 0) return true;
    return false;
  }

  private pendingEvents(limit: number): NodeEventMessage[] {
    const events: NodeEventMessage[] = [];
    for (const run of this.runEvents.values()) {
      for (const event of run.pending) {
        if (events.length >= limit) return events;
        events.push(event);
      }
    }
    return events;
  }

  private async post(path: string, body: unknown): Promise<Response> {
    const response = await this.fetchImpl(`${this.hubUrl}${path}`, {
      body: JSON.stringify(body),
      headers: { ...this.headers(), "content-type": "application/json" },
      // 上报频率低，不复用连接：Bun 1.3.14 同进程复用 keep-alive 连接时第二个 POST 会被服务端以 400 拒收。
      keepalive: false,
      method: "POST",
      signal: this.abort.signal
    });
    await assertOk(response);
    return response;
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.options.token}` };
  }
}

export type NodePathCheckResult = { directory: boolean; exists: boolean; git_repo: boolean; path: string };

const builtinHandlers: Record<string, NodeCommandHandler> = {
  // 与中心本机的项目路径检查同形；只有越出 allowedRoots 才报错，不存在的路径如实返回 exists=false。
  "path.check": async (params, agent): Promise<NodePathCheckResult> => {
    const path = String((isRecord(params) ? params.path : undefined) ?? "");
    if (!isAbsolute(path) || path.includes("\0")) throw new Error("path must be absolute");
    const entry = await stat(path).catch(() => null);
    if (!entry) {
      if (!agent.allowedRoots.some((root) => isWithin(root, resolve(path)))) throw new Error("path is outside the node's allowed roots");
      return { directory: false, exists: false, git_repo: false, path: resolve(path) };
    }
    const resolved = await agent.resolveAllowedPath(path);
    const directory = entry.isDirectory();
    const git = directory ? await stat(join(resolved, ".git")).catch(() => null) : null;
    return { directory, exists: true, git_repo: Boolean(git?.isDirectory() || git?.isFile()), path: resolved };
  }
};

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  const message = await response.text().catch(() => "");
  if (response.status === 401) throw new NodeAgentFatalError("hub rejected the node token (revoked or wrong)");
  if (response.status === 409) throw new NodeAgentFatalError(message || "protocol mismatch with hub");
  throw new Error(`hub responded ${response.status}${message ? `: ${message.slice(0, 200)}` : ""}`);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep) => {
    const timer = setTimeout(resolveSleep, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolveSleep();
    }, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
