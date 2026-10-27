import type { NodeInfo } from "../db/repositories/nodes.ts";
import type { ApprovalDecision, InterruptInput, ProviderEvent, ProviderRunInput, ProviderRunResult } from "../providers/types.ts";

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

/** 远程项目提示里托管 Skill 目录的占位符，节点替换为本机缓存根目录。 */
export const NODE_SKILL_ROOT_TOKEN = "{{xuanwu-node-skills}}";

export type NodeFilePayload = { data: string; path: string };

/** run.start 的参数：ProviderRunInput 去掉回调；中心本机的图片与 Skill 目录改为随指令下发文件内容。 */
export type NodeRunStartParams = {
  images?: Array<{ data: string; detail?: "high" | "original"; name: string }>;
  input: Omit<ProviderRunInput, "images" | "onEvent" | "skillPackages">;
  providerId: string;
  runRef: string;
  skillPackages?: Array<{ directory: string; files: NodeFilePayload[] }>;
};
export type NodeRunInterruptParams = { input: InterruptInput; providerId: string };
export type NodeApprovalResolveParams = { decision: ApprovalDecision; providerId: string; requestId: string };

/** 一次远程运行经 event 通道回传的内容：若干 provider 事件，最后以 result 或 error 收尾。 */
export type NodeRunEvent =
  | { type: "event"; event: ProviderEvent }
  | { type: "result"; result: ProviderRunResult }
  | { type: "error"; interrupted: boolean; message: string };

/**
 * 运行是否已到终点。不少 provider（如 Codex）的 run() 在一轮开始时就返回，
 * 之后的消息、审批与完成信号仍经 onEvent 推送，所以远程运行要转发到终止事件为止。
 */
export function isTerminalProviderEvent(event: ProviderEvent): boolean {
  return event.type === "error" || event.runEvent?.terminal === true;
}
