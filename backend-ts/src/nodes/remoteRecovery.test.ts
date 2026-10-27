import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { listIssueRuns } from "../db/repositories/issues.ts";
import { createRemoteNode } from "../db/repositories/nodes.ts";
import { listActiveRemoteRuns } from "../db/repositories/remoteRuns.ts";
import { recordRequestPeerAddress } from "../http/peerAddress.ts";
import { createDefaultRouter, createRequestHandler } from "../http/server.ts";
import { runProjectLoopOnce } from "../runner/projectLoop.ts";
import { FIXTURE_TIME, insertIssue } from "../testing/harness.ts";
import { NodeAgent } from "./agent.ts";
import { startNodeHubRuntime } from "./hubRuntime.ts";
import { nodeExecutionHandlers, nodeProviderInfo } from "./nodeExecutor.ts";
import { nodeGitHandlers } from "./nodeGit.ts";
import { adminFetch, fakeNodeProvider, TEST_ADMIN_TOKEN, waitUntil } from "./testing.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** 一个可停可重启的「中心进程」：同一数据库、同一端口，模拟中心崩溃后重启。 */
function startHub(database: RunnerDatabase, port: number, reattachGraceMs?: number) {
  const runtime = startNodeHubRuntime({ database, reattachGraceMs });
  const handle = createRequestHandler(createDefaultRouter({ database, nodeHub: runtime.hub, providers: {} }), TEST_ADMIN_TOKEN);
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

/** 一个「节点进程」：重新创建即等同于节点重启（内存中的在途运行全部丢失）。 */
function startNode(baseUrl: string, token: string, allowed: string) {
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
  const stop = async () => {
    agent.stop();
    await running;
  };
  cleanups.push(stop);
  return { fake, stop };
}

async function setup(reattachGraceMs?: number) {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-remote-recovery-"));
  cleanups.push(() => rm(root, { force: true, recursive: true }));
  const allowed = join(root, "code");
  await mkdir(join(allowed, "repo"), { recursive: true });
  const database = await openDatabase({ stateDir: join(root, "state") });
  cleanups.push(() => database.close());
  const hubA = startHub(database, 0, reattachGraceMs);
  const { node, token } = createRemoteNode(database, { name: "laptop" });
  const nodeA = startNode(hubA.baseUrl, token, allowed);
  await waitUntil(() => hubA.hub.isOnline(node.id));
  await adminFetch(hubA.baseUrl, "/api/projects", {
    body: JSON.stringify({ cwd: await realpath(join(allowed, "repo")), id: "remote-repo", node_id: node.id, provider: "codex" }),
    method: "POST"
  });
  return { allowed, database, hubA, nodeA, nodeId: node.id, token };
}

const eventTypes = (db: RunnerDatabase, issueId: number) => listIssueEvents(db, issueId, { limit: 200 }).map((event) => event.type);

describe("unattended recovery of remote runs", () => {
  test("a restarted hub reattaches to a run still going on the node and finishes it", async () => {
    const { database, hubA, nodeId } = await setup();
    const issueId = insertIssue(database, { project_id: "remote-repo", status: "todo", title: "[[slow]] work", updated_at: FIXTURE_TIME });
    await runProjectLoopOnce({ database, projectId: "remote-repo", providers: {} });
    await waitUntil(() => listActiveRemoteRuns(database, nodeId).length === 1);

    // 中心崩溃并在同一端口重启；节点上的运行继续，节点自行重连。
    hubA.stop();
    const hubB = startHub(database, hubA.port);
    await waitUntil(() => hubB.hub.isOnline(nodeId), 4_000);

    await waitUntil(() => listIssueRuns(database, issueId)[0]?.ended_at !== "", 4_000);
    expect(listIssueRuns(database, issueId)[0]?.status).toBe("succeeded");
    expect(eventTypes(database, issueId)).toContain("issue.remote_run_reattached.v1");
    await waitUntil(() => eventTypes(database, issueId).includes("issue.pi_acceptance_requested.v1"));
    expect(listActiveRemoteRuns(database)).toEqual([]);
  });

  test("a restarted node fails its lost runs at once instead of after the offline grace", async () => {
    const { allowed, database, hubA, nodeA, nodeId, token } = await setup();
    const issueId = insertIssue(database, { project_id: "remote-repo", status: "todo", title: "[[wait]] forever", updated_at: FIXTURE_TIME });
    const running = runProjectLoopOnce({ database, projectId: "remote-repo", providers: {} });
    await waitUntil(() => listActiveRemoteRuns(database, nodeId).length === 1);

    // 节点进程重启：新进程没有任何在途运行。
    await nodeA.stop();
    startNode(hubA.baseUrl, token, allowed);
    await running;

    await waitUntil(() => listIssueRuns(database, issueId)[0]?.ended_at !== "", 4_000);
    expect(listIssueRuns(database, issueId)[0]?.status).toBe("failed");
    expect(listActiveRemoteRuns(database)).toEqual([]);
  });

  test("runs whose node never returns after a hub restart are closed after the grace period", async () => {
    const { database, hubA, nodeA, nodeId } = await setup();
    const issueId = insertIssue(database, { project_id: "remote-repo", status: "todo", title: "[[wait]] forever", updated_at: FIXTURE_TIME });
    void runProjectLoopOnce({ database, projectId: "remote-repo", providers: {} });
    await waitUntil(() => listActiveRemoteRuns(database, nodeId).length === 1);

    hubA.stop();
    await nodeA.stop();
    startHub(database, 0, 200);

    await waitUntil(() => listIssueRuns(database, issueId)[0]?.ended_at !== "", 2_000);
    expect(listIssueRuns(database, issueId)[0]?.status).toBe("failed");
    expect(eventTypes(database, issueId)).toContain("issue.remote_run_lost.v1");
  });
});
