import { randomUUID } from "node:crypto";
import type { NodeCommand, NodeUpstreamMessage } from "./protocol.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

type NodeChannel = {
  /** 写入一条 SSE 帧；返回 false 表示连接已断或积压超限。 */
  write(frame: string): boolean;
  close(): void;
};

type PendingRequest = {
  nodeID: string;
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

type RunEventListener = (event: unknown, seq: number) => void;
type StatusListener = (nodeID: string, online: boolean) => void;

export class NodeOfflineError extends Error {
  override readonly name = "NodeOfflineError";
}

/**
 * 中心侧的节点连接表：每个节点至多一条下行 SSE 通道；
 * 指令以 id 关联节点的 POST 响应，运行事件按 runRef 分发并按 seq 去重。
 */
export class NodeHub {
  private readonly channels = new Map<string, NodeChannel>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly runListeners = new Map<string, RunEventListener>();
  private readonly runSeq = new Map<string, number>();
  private readonly statusListeners = new Set<StatusListener>();

  attach(nodeID: string, channel: NodeChannel): () => void {
    const previous = this.channels.get(nodeID);
    this.channels.set(nodeID, channel);
    // 同一节点重连时旧通道作废，但它上面的在途请求仍可由新通道的 POST 响应完成。
    previous?.close();
    if (!previous) this.emitStatus(nodeID, true);
    return () => this.detach(nodeID, channel);
  }

  isOnline(nodeID: string): boolean {
    return this.channels.has(nodeID);
  }

  onlineNodeIDs(): string[] {
    return [...this.channels.keys()];
  }

  onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  request(nodeID: string, method: string, params: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
    const channel = this.channels.get(nodeID);
    if (!channel) return Promise.reject(new NodeOfflineError(`node ${nodeID} is offline`));
    const command: NodeCommand = { id: randomUUID(), method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.id);
        reject(new Error(`node ${nodeID} did not answer ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(command.id, { nodeID, reject, resolve, timer });
      if (!channel.write(`data: ${JSON.stringify(command)}\n\n`)) {
        this.settle(command.id, new NodeOfflineError(`node ${nodeID} channel closed`));
      }
    });
  }

  /** 订阅某次远程运行的事件；返回取消函数。 */
  subscribeRun(runRef: string, listener: RunEventListener): () => void {
    this.runListeners.set(runRef, listener);
    return () => {
      if (this.runListeners.get(runRef) === listener) this.runListeners.delete(runRef);
      this.runSeq.delete(runRef);
    };
  }

  /** 处理节点 POST 上来的一批消息，返回每个 runRef 已确认的最大 seq。 */
  receive(nodeID: string, messages: NodeUpstreamMessage[]): Record<string, number> {
    const acks: Record<string, number> = {};
    for (const message of messages) {
      if (message.type === "res") {
        const request = this.pending.get(message.id);
        if (!request || request.nodeID !== nodeID) continue;
        this.settle(message.id, message.ok ? undefined : new Error(message.error), message.ok ? message.result : undefined);
        continue;
      }
      const last = this.runSeq.get(message.runRef) ?? 0;
      if (message.seq > last) {
        this.runListeners.get(message.runRef)?.(message.event, message.seq);
        this.runSeq.set(message.runRef, message.seq);
      }
      acks[message.runRef] = Math.max(acks[message.runRef] ?? 0, this.runSeq.get(message.runRef) ?? message.seq);
    }
    return acks;
  }

  disconnect(nodeID: string): void {
    const channel = this.channels.get(nodeID);
    if (channel) this.detach(nodeID, channel);
    channel?.close();
  }

  private detach(nodeID: string, channel: NodeChannel): void {
    if (this.channels.get(nodeID) !== channel) return;
    this.channels.delete(nodeID);
    for (const [id, request] of this.pending) {
      if (request.nodeID === nodeID) this.settle(id, new NodeOfflineError(`node ${nodeID} disconnected`));
    }
    this.emitStatus(nodeID, false);
  }

  private settle(id: string, error?: Error, result?: unknown): void {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    clearTimeout(request.timer);
    if (error) request.reject(error);
    else request.resolve(result);
  }

  private emitStatus(nodeID: string, online: boolean): void {
    for (const listener of this.statusListeners) {
      try {
        listener(nodeID, online);
      } catch (error) {
        console.warn(JSON.stringify({ event: "nodes.status_listener_failed", error: String(error) }));
      }
    }
  }
}
