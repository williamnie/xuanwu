import type { NodeInfo } from "../db/repositories/nodes.ts";

/** 节点主动发起的三条通道；中心不回连节点。 */
export const NODE_HELLO_PATH = "/api/nodes/agent/hello";
export const NODE_STREAM_PATH = "/api/nodes/agent/stream";
export const NODE_MESSAGES_PATH = "/api/nodes/agent/messages";
export const NODE_AGENT_PATH_PREFIX = "/api/nodes/agent/";

export const NODE_PROTOCOL_VERSION = 1;
/** 中心写心跳注释帧的间隔；节点超过 NODE_STREAM_IDLE_MS 未收到数据即重连。 */
export const NODE_HEARTBEAT_MS = 15_000;
export const NODE_STREAM_IDLE_MS = 45_000;

export type NodeHelloRequest = NodeInfo & { protocol: number };
export type NodeHelloResponse = { node_id: string; name: string; protocol: number; private_network: boolean };

/** 中心 → 节点：经 SSE `data:` 下发的指令。 */
export type NodeCommand = { id: string; method: string; params: unknown };

/** 节点 → 中心：经 POST 批量上报。 */
export type NodeResponseMessage = { type: "res"; id: string; ok: true; result: unknown } | { type: "res"; id: string; ok: false; error: string };
export type NodeEventMessage = { type: "event"; runRef: string; seq: number; event: unknown };
export type NodeUpstreamMessage = NodeResponseMessage | NodeEventMessage;
export type NodeMessagesRequest = { messages: NodeUpstreamMessage[] };

export const NODE_MESSAGES_MAX_BATCH = 256;
