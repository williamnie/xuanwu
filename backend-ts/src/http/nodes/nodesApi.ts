import type { RunnerDatabase } from "../../db/database.ts";
import {
  createRemoteNode,
  findRemoteNodeByToken,
  listRemoteNodes,
  normalizeNodeInfo,
  recordRemoteNodeHello,
  revokeRemoteNode,
  touchRemoteNode,
  type RemoteNode
} from "../../db/repositories/nodes.ts";
import type { NodeHub } from "../../nodes/hub.ts";
import { isPrivateNetworkAddress } from "../../nodes/network.ts";
import {
  NODE_HEARTBEAT_MS,
  NODE_HELLO_PATH,
  NODE_MESSAGES_MAX_BATCH,
  NODE_MESSAGES_PATH,
  NODE_PROTOCOL_VERSION,
  NODE_STREAM_PATH,
  type NodeHelloResponse,
  type NodeUpstreamMessage
} from "../../nodes/protocol.ts";
import { bunBuildInfo } from "../../buildInfo.ts";
import { requestBearerToken } from "../auth.ts";
import { createBoundedEventStream } from "../boundedEventStream.ts";
import { HttpError, json, jsonError, parseJsonBody } from "../errors.ts";
import { requestPeerAddress } from "../peerAddress.ts";
import type { Router } from "../router.ts";
import { cleanString } from "../../util/values.ts";

type NodesApiContext = {
  database: RunnerDatabase;
  heartbeatMs?: number;
  hub: NodeHub;
};

export function registerNodesRoutes(router: Router, context: NodesApiContext): void {
  // 管理接口：走全局 Bearer 鉴权。
  router.get("/api/nodes", () => json({ nodes: listRemoteNodes(context.database).map((node) => nodeView(context, node)) }));
  router.post("/api/nodes", async (request) => {
    const body = await parseObjectBody(request);
    const created = createRemoteNode(context.database, { name: body.name });
    return json({ node: nodeView(context, created.node), token: created.token }, { status: 201 });
  });
  router.delete("/api/nodes/:id", (request) => {
    const id = decodeURIComponent(new URL(request.url).pathname.split("/")[3] ?? "");
    if (!revokeRemoteNode(context.database, id)) return jsonError(404, "node not found");
    context.hub.disconnect(id);
    return json({ ok: true });
  });

  // 节点通道：用节点自己的密钥鉴权（已从全局鉴权中豁免）。
  router.post(NODE_HELLO_PATH, async (request) => {
    const node = authenticateNode(context, request);
    const body = await parseObjectBody(request);
    if (body.protocol !== NODE_PROTOCOL_VERSION) {
      return jsonError(409, `unsupported node protocol ${String(body.protocol)}; hub speaks ${NODE_PROTOCOL_VERSION}`);
    }
    const remoteAddr = requestPeerAddress(request);
    const saved = recordRemoteNodeHello(context.database, node.id, { info: normalizeNodeInfo(body), remoteAddr });
    const activeRuns = Array.isArray(body.active_runs)
      ? body.active_runs.filter((run): run is string => typeof run === "string").slice(0, 1_000)
      : [];
    context.hub.reportHello(saved.id, activeRuns);
    const response: NodeHelloResponse = {
      name: saved.name,
      node_id: saved.id,
      private_network: isPrivateNetworkAddress(remoteAddr),
      protocol: NODE_PROTOCOL_VERSION
    };
    return json(response);
  });
  router.get(NODE_STREAM_PATH, (request) => nodeStreamResponse(context, authenticateNode(context, request), request.signal));
  router.post(NODE_MESSAGES_PATH, async (request) => {
    const node = authenticateNode(context, request);

    const messages = parseUpstreamMessages(await parseJsonBody(request));
    return json({ acks: context.hub.receive(node.id, messages) });
  });
}

function nodeStreamResponse(context: NodesApiContext, node: RemoteNode, signal: AbortSignal): Response {
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let detach: (() => void) | undefined;
  const output = createBoundedEventStream({
    signal,
    onClose() {
      if (heartbeat !== undefined) clearInterval(heartbeat);
      detach?.();
    }
  });
  if (output.write(`retry: 1000\n\n: connected\n\n`)) {
    detach = context.hub.attach(node.id, { close: () => output.close(), write: (frame) => output.write(frame) });
    touchRemoteNode(context.database, node.id);
    heartbeat = setInterval(() => {
      if (output.write(": heartbeat\n\n")) touchRemoteNode(context.database, node.id);
    }, context.heartbeatMs ?? NODE_HEARTBEAT_MS);
  }
  return new Response(output.stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no"
    }
  });
}

function authenticateNode(context: NodesApiContext, request: Request): RemoteNode {
  const node = findRemoteNodeByToken(context.database, requestBearerToken(request));
  if (!node) throw new HttpError(401, "unauthorized");
  return node;
}

function nodeView(context: NodesApiContext, node: RemoteNode) {
  const hubVersion = bunBuildInfo().version;
  return {
    ...node,
    hub_version: hubVersion,
    online: context.hub.isOnline(node.id),
    // 节点与中心版本不同可能缺少新的协议能力，提示升级节点。
    version_mismatch: node.info.version !== "" && node.info.version !== hubVersion,
    private_network: node.last_remote_addr === "" ? null : isPrivateNetworkAddress(node.last_remote_addr)
  };
}

function parseUpstreamMessages(value: unknown): NodeUpstreamMessage[] {
  const messages = isRecord(value) && Array.isArray(value.messages) ? value.messages : null;
  if (!messages) throw new HttpError(400, "messages must be an array");
  if (messages.length > NODE_MESSAGES_MAX_BATCH) throw new HttpError(413, `at most ${NODE_MESSAGES_MAX_BATCH} messages per batch`);
  return messages.map((message): NodeUpstreamMessage => {
    if (!isRecord(message)) throw new HttpError(400, "invalid message");
    if (message.type === "res" && cleanString(message.id) !== "") {
      return message.ok === true
        ? { type: "res", id: cleanString(message.id), ok: true, result: message.result }
        : { type: "res", id: cleanString(message.id), ok: false, error: cleanString(message.error) || "node request failed" };
    }
    if (message.type === "event" && cleanString(message.runRef) !== "" && Number.isSafeInteger(message.seq) && Number(message.seq) > 0) {
      return { type: "event", runRef: cleanString(message.runRef), seq: Number(message.seq), event: message.event };
    }
    throw new HttpError(400, "invalid message");
  });
}

async function parseObjectBody(request: Request): Promise<Record<string, unknown>> {
  const body = await parseJsonBody(request);
  if (!isRecord(body)) throw new HttpError(400, "body must be an object");
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
