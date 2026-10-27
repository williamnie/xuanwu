import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { NodeAgent, NodeAgentFatalError } from "../../nodes/agent.ts";
import { NodeHub } from "../../nodes/hub.ts";
import { useDatabaseCleanup } from "../../testing/harness.ts";
import { recordRequestPeerAddress } from "../peerAddress.ts";
import { createRouter } from "../router.ts";
import { createRequestHandler } from "../server.ts";
import { registerNodesRoutes } from "./nodesApi.ts";

const ADMIN_TOKEN = "admin-token";
const trackDatabase = useDatabaseCleanup();
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function startHub(): Promise<{ baseUrl: string; database: RunnerDatabase; hub: NodeHub; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-nodes-api-"));
  cleanups.push(() => rm(root, { force: true, recursive: true }));
  const database = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
  const hub = new NodeHub();
  const router = createRouter();
  registerNodesRoutes(router, { database, heartbeatMs: 50, hub });
  const handle = createRequestHandler(router, ADMIN_TOKEN);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, bunServer) => {
      recordRequestPeerAddress(request, bunServer);
      return handle(request);
    }
  });
  cleanups.push(() => server.stop(true));
  return { baseUrl: `http://127.0.0.1:${server.port}`, database, hub, root };
}

async function adminFetch(baseUrl: string, path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json", ...init.headers }
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
}

describe("nodes API", () => {
  test("admin endpoints require the global token and never return the token hash", async () => {
    const { baseUrl } = await startHub();
    expect((await fetch(`${baseUrl}/api/nodes`)).status).toBe(401);
    const created = await adminFetch(baseUrl, "/api/nodes", { body: JSON.stringify({ name: "laptop" }), method: "POST" });
    expect(created.status).toBe(201);
    const body = await created.json() as { node: Record<string, unknown>; token: string };
    expect(body.token).toStartWith("xwn_");
    expect(body.node).not.toHaveProperty("token_hash");
    // 节点密钥不能当作管理凭据使用。
    const asNode = await fetch(`${baseUrl}/api/nodes`, { headers: { authorization: `Bearer ${body.token}` } });
    expect(asNode.status).toBe(401);
  });

  test("a node connects, reports itself and answers path checks within its allowed roots", async () => {
    const { baseUrl, hub, root } = await startHub();
    const allowed = join(root, "code");
    await mkdir(join(allowed, "repo"), { recursive: true });
    await mkdir(join(root, "outside"), { recursive: true });
    const { node, token } = await (await adminFetch(baseUrl, "/api/nodes", {
      body: JSON.stringify({ name: "laptop" }), method: "POST"
    })).json() as { node: { id: string }; token: string };

    const agent = new NodeAgent({ allowedRoots: [allowed], hubUrl: baseUrl, log: () => {}, token });
    const running = agent.run();
    cleanups.push(async () => {
      agent.stop();
      await running.catch(() => {});
    });
    await waitFor(() => hub.isOnline(node.id));

    const listed = await (await adminFetch(baseUrl, "/api/nodes")).json() as { nodes: Array<Record<string, unknown>> };
    expect(listed.nodes).toHaveLength(1);
    expect(listed.nodes[0]).toMatchObject({ id: node.id, last_remote_addr: "127.0.0.1", online: true, private_network: true });
    expect((listed.nodes[0]!.info as { allowed_roots: string[] }).allowed_roots).toEqual([allowed]);

    expect(await hub.request(node.id, "path.check", { path: join(allowed, "repo") })).toMatchObject({ path: expect.stringContaining("repo") });
    await expect(hub.request(node.id, "path.check", { path: join(root, "outside") })).rejects.toThrow("outside the node's allowed roots");
    await expect(hub.request(node.id, "path.check", { path: join(allowed, "repo", "..", "..", "outside") })).rejects.toThrow("outside");
    await expect(hub.request(node.id, "no.such.method", {})).rejects.toThrow("unknown method");
  });

  test("revoking a node disconnects it and its agent stops with a fatal error", async () => {
    const { baseUrl, hub } = await startHub();
    const { node, token } = await (await adminFetch(baseUrl, "/api/nodes", {
      body: JSON.stringify({ name: "laptop" }), method: "POST"
    })).json() as { node: { id: string }; token: string };
    const agent = new NodeAgent({ allowedRoots: [], hubUrl: baseUrl, log: () => {}, token });
    const running = agent.run();
    cleanups.push(() => agent.stop());
    await waitFor(() => hub.isOnline(node.id));

    expect((await adminFetch(baseUrl, `/api/nodes/${node.id}`, { method: "DELETE" })).status).toBe(200);
    expect(hub.isOnline(node.id)).toBe(false);
    await expect(running).rejects.toBeInstanceOf(NodeAgentFatalError);
    expect((await adminFetch(baseUrl, "/api/nodes")).json()).resolves.toEqual({ nodes: [] });
  });

  test("rejects unknown node tokens on every agent channel", async () => {
    const { baseUrl } = await startHub();
    const headers = { authorization: "Bearer xwn_unknown", "content-type": "application/json" };
    expect((await fetch(`${baseUrl}/api/nodes/agent/stream`, { headers })).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/nodes/agent/hello`, { body: "{}", headers, method: "POST" })).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/nodes/agent/messages`, { body: "{\"messages\":[]}", headers, method: "POST" })).status).toBe(401);
  });
});
