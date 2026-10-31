import type { NodeInfo } from "../db/repositories/nodes.ts";
import type { NodeAgent } from "./agent.connection.ts";

export const RECONNECT_MIN_MS = 1_000;

export const RECONNECT_MAX_MS = 30_000;

/** 每次运行未确认事件的上限；超出后丢弃最旧的事件，中心按 seq 缺口感知。 */
export const RUN_EVENT_BUFFER_LIMIT = 4_096;

export const FLUSH_RETRY_MS = 2_000;

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
