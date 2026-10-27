import { afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { EventBus } from "../events/bus.ts";
import { createRemoteNode } from "../db/repositories/nodes.ts";
import { recordRequestPeerAddress } from "../http/peerAddress.ts";
import { createDefaultRouter, createRequestHandler } from "../http/server.ts";
import {
  asProviderId,
  ProviderInterruptedError,
  type ExecutorProvider,
  type ExecutorProviderId,
  type ProviderRecoveryInput,
  type ProviderRunInput,
  type SessionCreateInput,
  type SessionMessageInput,
  type SessionRef
} from "../providers/types.ts";
import { providerSessionDetail, providerSessionSummary, type ProviderSessionTurn } from "../providers/core/sessionView.ts";
import { normalizedRunEvent } from "../providers/runEvents.ts";
import { NodeAgent } from "./agent.ts";
import type { NodeHub } from "./hub.ts";
import { startNodeHubRuntime } from "./hubRuntime.ts";
import { nodeExecutionHandlers, nodeProviderInfo } from "./nodeExecutor.ts";
import { nodeGitHandlers } from "./nodeGit.ts";

export const TEST_ADMIN_TOKEN = "admin";

/** 可控的节点本机 provider：记录收到的输入；prompt 含 [[fail]] 时报错，含 [[wait]] 时挂起直到被中断，含 [[late]] 时先返回再推送后续事件，含 [[edit]] 时在工作区写 edited.txt。 */
export function fakeNodeProvider() {
  const received: ProviderRunInput[] = [];
  const recovered: ProviderRecoveryInput[] = [];
  const createdSessions: SessionCreateInput[] = [];
  const sessionMessages: SessionMessageInput[] = [];
  const approvals: Array<[string, unknown]> = [];
  let interruptActive: (() => void) | undefined;
  /** run 与 recover 共用的脚本：按 prompt 里的标记决定行为。 */
  const execute = async (input: ProviderRunInput, session: SessionRef) => {
    input.onEvent?.({ type: "turn.started", provider: "codex", session });
    input.onEvent?.({ type: "agent.message", provider: "codex", session, text: "hello from node" });
    if (input.prompt.includes("[[fail]]")) throw new Error("model exploded");
    // 模拟编程工具在节点的工作区里改文件。
    if (input.prompt.includes("[[edit]]")) await writeFile(join(input.cwd, "edited.txt"), "made on the node\n");
    if (input.prompt.includes("[[late]]") || input.prompt.includes("[[slow]]")) {
      // 模拟 Codex：run() 在一轮开始时返回，消息与完成信号随后才推送（[[slow]] 推迟到 1.5s 后）。
      setTimeout(() => {
        input.onEvent?.({ type: "agent.message", provider: "codex", session, text: "late message" });
        input.onEvent?.({
          type: "turn.completed",
          provider: "codex",
          session,
          status: "completed",
          raw: { method: "turn/completed" },
          runEvent: normalizedRunEvent({ kind: "completed", method: "turn/completed", outcome: "succeeded", provider: "codex", session })
        });
      }, input.prompt.includes("[[slow]]") ? 1_500 : 50);
    }
    if (input.prompt.includes("[[wait]]")) {
      await new Promise<void>((_resolve, reject) => {
        interruptActive = () => reject(new ProviderInterruptedError("interrupted by user"));
      });
    }
    return { runId: `run-on-node-${input.issueId}`, session };
  };
  const provider: ExecutorProvider = {
    id: asProviderId("codex"),
    capabilities: ["issue_execution", "interrupt", "approvals", "sessions", "model_list", "resume_session"],
    interruptScope: "turn",
    run: async (input) => {
      received.push(input);
      return await execute(input, { provider: "codex", sessionId: `thread-${input.issueId}`, turnId: `turn-${input.issueId}` });
    },
    // 原会话续跑：沿用会话，开新的一轮。
    recover: async (input) => {
      recovered.push(input);
      return await execute(input, { ...input.session, turnId: `turn-${input.issueId}-r${recovered.length}` });
    },
    interrupt: async () => interruptActive?.(),
    createSession: async (input) => {
      createdSessions.push(input);
      const id = `chat-${createdSessions.length}`;
      return { id: `codex:${id}`, provider: "codex", provider_session_id: id, provider_turn_id: "chat-turn-1", thread_id: id, turn_id: "chat-turn-1" };
    },
    sendSessionMessage: async (input) => {
      sessionMessages.push(input);
      return { provider: "codex", provider_session_id: input.sessionId, sessionId: input.sessionId, turn_id: `msg-turn-${sessionMessages.length}` };
    },
    listSessions: async () => ({ data: [providerSessionSummary(asProviderId("codex"), { name: "node chat", sessionRef: "chat-1" })] }),
    listModels: async () => [{ id: "node-model", display_name: "Node model" }],
    readSession: async (sessionId) => providerSessionDetail(asProviderId("codex"), {
      sessionRef: sessionId,
      turns: [{ id: "turn-on-node", items: [], status: "completed" } as ProviderSessionTurn]
    }),
    resolveApproval: async (requestId, decision) => {
      approvals.push([requestId, decision]);
    },
    runtimeStatus: () => ({ active_sessions: 0, api_key_configured: true, mode: "rpc", ready: true, version: "0.99.0" })
  };
  return { approvals, createdSessions, provider, received, recovered, sessionMessages };
}

export type TestNodeHub = {
  agent: NodeAgent;
  /** 节点允许的根目录，内含 repo/ 子目录。 */
  allowed: string;
  baseUrl: string;
  database: RunnerDatabase;
  fake: ReturnType<typeof fakeNodeProvider>;
  hub: NodeHub;
  nodeId: string;
  /** 中心事件总线上发布过的事件（含节点送回的会话事件）。 */
  published: unknown[];
};

/** 每个测试一套：真实数据库 + 完整路由的中心 HTTP 服务 + 已连上的 NodeAgent（使用假 provider）。 */
export function useTestNodeHub(): () => Promise<TestNodeHub> {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
  });
  return async () => {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-node-hub-"));
    cleanups.push(() => rm(root, { force: true, recursive: true }));
    const allowed = join(root, "code");
    await mkdir(join(allowed, "repo"), { recursive: true });
    const database = await openDatabase({ stateDir: join(root, "state") });
    cleanups.push(() => database.close());
    const published: unknown[] = [];
    const bus = new EventBus();
    const subscription = bus.subscribe();
    void (async () => {
      for (let event = await subscription.next(); event; event = await subscription.next()) published.push(event);
    })();
    cleanups.push(() => subscription.close());
    const runtime = startNodeHubRuntime({ bus, database });
    cleanups.push(() => runtime.stop());
    const handle = createRequestHandler(createDefaultRouter({ bus, database, nodeHub: runtime.hub, providers: {} }), TEST_ADMIN_TOKEN);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, bunServer) => {
        recordRequestPeerAddress(request, bunServer);
        return handle(request);
      }
    });
    cleanups.push(() => server.stop(true));
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const { node, token } = createRemoteNode(database, { name: "laptop" });
    const fake = fakeNodeProvider();
    const providers = () => ({ codex: fake.provider });
    const agent = new NodeAgent({
      allowedRoots: [allowed],
      handlers: { ...nodeExecutionHandlers(providers), ...nodeGitHandlers },
      hubUrl: baseUrl,
      info: () => ({ hostname: "laptop", os: "linux", providers: nodeProviderInfo(providers()), version: "test" }),
      log: () => {},
      token
    });
    const running = agent.run().catch(() => {});
    cleanups.push(async () => {
      agent.stop();
      await running;
    });
    await waitUntil(() => runtime.hub.isOnline(node.id));
    return { agent, allowed, baseUrl, database, fake, hub: runtime.hub, nodeId: node.id, published };
  };
}

/**
 * 可停可重启的「中心进程」与「节点进程」：同一数据库与端口重启中心模拟中心崩溃，
 * 重新创建节点等同于节点重启（内存中的在途运行全部丢失）。
 */
export function useNodeHubProcesses() {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
  });

  async function tempDir() {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-node-processes-"));
    cleanups.push(() => rm(root, { force: true, recursive: true }));
    const allowed = join(root, "code");
    await mkdir(join(allowed, "repo"), { recursive: true });
    const database = await openDatabase({ stateDir: join(root, "state") });
    cleanups.push(() => database.close());
    return { allowed, database, root };
  }

  function startHub(database: RunnerDatabase, port: number, reattachGraceMs?: number, providers: Partial<Record<ExecutorProviderId, ExecutorProvider>> = {}) {
    const runtime = startNodeHubRuntime({ database, reattachGraceMs });
    const handle = createRequestHandler(createDefaultRouter({ database, nodeHub: runtime.hub, providers }), TEST_ADMIN_TOKEN);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: (request, bunServer) => {
        recordRequestPeerAddress(request, bunServer);
        return handle(request);
      }
    });
    const stop = () => {
      server.stop(true);
      runtime.stop();
    };
    cleanups.push(stop);
    return { baseUrl: `http://127.0.0.1:${server.port}`, hub: runtime.hub, port: server.port!, stop };
  }

  function startNode(baseUrl: string, token: string, allowed: string, maxParallel?: number) {
    const fake = fakeNodeProvider();
    const providers = () => ({ codex: fake.provider });
    const agent = new NodeAgent({
      allowedRoots: [allowed],
      handlers: { ...nodeExecutionHandlers(providers), ...nodeGitHandlers },
      hubUrl: baseUrl,
      info: () => ({ hostname: "laptop", ...(maxParallel ? { max_parallel: maxParallel } : {}), os: "linux", providers: nodeProviderInfo(providers()), version: "test" }),
      log: () => {},
      token
    });
    const running = agent.run().catch(() => {});
    const stop = async () => {
      agent.stop();
      await running;
    };
    cleanups.push(stop);
    return { fake, stop };
  }

  return { startHub, startNode, tempDir };
}

export async function waitUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
}

export async function adminFetch(baseUrl: string, path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}`, "content-type": "application/json", ...init.headers }
  });
}
