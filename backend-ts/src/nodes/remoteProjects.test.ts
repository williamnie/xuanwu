import { describe, expect, test } from "bun:test";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { createProject, getProject, listProjects } from "../db/repositories/projects.ts";
import { cancelIssueWithInterrupt } from "../runner/interrupt.ts";
import { projectLoopDecision, runProjectLoopOnce } from "../runner/projectLoop.ts";
import { FIXTURE_TIME, insertIssue } from "../testing/harness.ts";
import { adminFetch, useTestNodeHub, waitUntil } from "./testing.ts";
import { providersForProjectCwd } from "./remoteExecution.ts";
import { createRemoteNode, getRemoteNode, recordRemoteNodeHello, revokeRemoteNode } from "../db/repositories/nodes.ts";
import { asProviderId } from "../providers/types.ts";

const startNodeHub = useTestNodeHub();

async function createRemoteProject(baseUrl: string, nodeId: string, cwd: string) {
  const response = await adminFetch(baseUrl, "/api/projects", {
    body: JSON.stringify({ cwd, id: "remote-repo", node_id: nodeId, provider: "codex" }),
    method: "POST"
  });
  return { body: await response.json() as Record<string, unknown>, status: response.status };
}

function addTodo(db: Parameters<typeof insertIssue>[0], title: string): number {
  return insertIssue(db, { project_id: "remote-repo", status: "todo", title, updated_at: FIXTURE_TIME });
}

describe("remote projects", () => {
  test("path checks run on the node and report the same shape as local checks", async () => {
    const { allowed, baseUrl, nodeId } = await startNodeHub();
    await mkdir(join(allowed, "repo", ".git"));
    const check = (cwd: string) => adminFetch(baseUrl, `/api/projects/path-check?node_id=${nodeId}&cwd=${encodeURIComponent(cwd)}`);

    const existing = await check(join(allowed, "repo"));
    expect(existing.status).toBe(200);
    expect(await existing.json()).toMatchObject({
      directory: true, exists: true, existing_project_id: null, git_repo: true, node_id: nodeId, suggested_id: "repo"
    });
    expect(await (await check(join(allowed, "missing"))).json()).toMatchObject({ directory: false, exists: false });
    const outside = await check("/etc");
    expect(outside.status).toBe(400);
    expect(await outside.json()).toEqual({ message: "path is outside the node's allowed roots" });
    expect((await adminFetch(baseUrl, `/api/projects/path-check?node_id=node_unknown&cwd=/x`)).status).toBe(404);
  });

  test("creates a remote project whose cwd is namespaced by node", async () => {
    const { allowed, baseUrl, nodeId } = await startNodeHub();
    const repo = await realpath(join(allowed, "repo"));
    const created = await createRemoteProject(baseUrl, nodeId, join(allowed, "repo"));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ cwd: `node://${nodeId}:${repo}`, id: "remote-repo", node_id: nodeId, node_path: repo });
    expect(created.body).not.toHaveProperty("node_id_input");

    const missing = await createRemoteProject(baseUrl, nodeId, join(allowed, "missing"));
    expect(missing.status).toBe(400);
    expect(await (await adminFetch(baseUrl, "/api/projects")).json()).toHaveLength(1);
  });

  test("path-check IDs let same-name local and remote projects coexist and reuse remote registrations", async () => {
    const { allowed, baseUrl, database, nodeId } = await startNodeHub();
    const cwd = join(allowed, "repo");
    const local = createProject(database, { cwd, id: "repo" });
    const checkPath = async () => {
      const response = await adminFetch(baseUrl, `/api/projects/path-check?${new URLSearchParams({ cwd, node_id: nodeId })}`);
      expect(response.status).toBe(200);
      return await response.json() as { existing_project_id: string | null; suggested_id: string };
    };
    const create = (id: string) => adminFetch(baseUrl, "/api/projects", {
      body: JSON.stringify({ cwd, id, node_id: nodeId }), method: "POST"
    });

    // 旧弹窗只用目录名，虽是不同位置也会撞到本机项目的主键。
    const duplicate = await create("repo");
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toMatchObject({ message: "UNIQUE constraint failed: projects.id" });

    const checked = await checkPath();
    expect(checked.existing_project_id).toBeNull();
    expect(checked.suggested_id).toMatch(/^repo-[a-f0-9]{8}$/);
    const created = await create(checked.suggested_id);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ id: checked.suggested_id, node_id: nodeId, node_path: await realpath(cwd) });

    const repeated = await checkPath();
    expect(repeated).toMatchObject({ existing_project_id: checked.suggested_id, suggested_id: checked.suggested_id });
    expect((await create(repeated.suggested_id)).status).toBe(201);
    expect(listProjects(database)).toHaveLength(2);
    expect(getProject(database, local.id)).toEqual(local);
  });

  test("the project loop executes a remote issue on the node and records its events", async () => {
    const { allowed, baseUrl, database, fake, nodeId } = await startNodeHub();
    await createRemoteProject(baseUrl, nodeId, join(allowed, "repo"));
    const issueId = addTodo(database, "Fix the login page");

    const published: unknown[] = [];
    const result = await runProjectLoopOnce({
      bus: { publish: (event) => published.push(event) },
      database,
      projectId: "remote-repo",
      providers: {}
    });

    expect(result.claimed).toBe(true);
    expect(fake.received).toHaveLength(1);
    expect(fake.received[0]).toMatchObject({ cwd: await realpath(join(allowed, "repo")), issueId, projectId: "remote-repo" });
    expect(fake.received[0]!.prompt).toContain("Fix the login page");
    // 执行策略在中心解析后随指令下发。
    expect(fake.received[0]!.policy).toBeDefined();
    expect(listIssueRuns(database, issueId)[0]).toMatchObject({ provider: "codex", provider_session_id: `thread-${issueId}` });
    // 节点上的 provider 事件回传到中心，经同一条事件链发布。
    expect(JSON.stringify(published)).toContain("hello from node");
  });

  test("a run whose provider returns early still finishes from the node's later terminal event", async () => {
    const { allowed, baseUrl, database, nodeId } = await startNodeHub();
    await createRemoteProject(baseUrl, nodeId, join(allowed, "repo"));
    const issueId = addTodo(database, "[[late]] like codex");

    await runProjectLoopOnce({ database, projectId: "remote-repo", providers: {} });

    await waitUntil(() => listIssueRuns(database, issueId)[0]?.ended_at !== "");
    expect(listIssueRuns(database, issueId)[0]?.status).toBe("succeeded");
  });

  test("cancelling a running remote issue interrupts it on the node", async () => {
    const { allowed, baseUrl, database, fake, nodeId } = await startNodeHub();
    await createRemoteProject(baseUrl, nodeId, join(allowed, "repo"));
    const issueId = addTodo(database, "[[wait]] for me");
    const running = runProjectLoopOnce({ database, projectId: "remote-repo", providers: {} });
    await waitUntil(() => fake.received.length === 1);
    await waitUntil(() => listIssueRuns(database, issueId)[0]?.provider_turn_id !== "");

    const cancelled = await cancelIssueWithInterrupt(database, issueId, { providers: {} });

    expect(cancelled.status).toBe("cancelled");
    await running;
    expect(getIssue(database, issueId)?.status).toBe("cancelled");
  });

  test("issues of an offline node wait instead of failing", async () => {
    const { agent, allowed, baseUrl, database, hub, nodeId } = await startNodeHub();
    await createRemoteProject(baseUrl, nodeId, join(allowed, "repo"));
    addTodo(database, "later");
    agent.stop();
    await waitUntil(() => !hub.isOnline(nodeId));

    const decision = projectLoopDecision({ database, projectId: "remote-repo", providers: {} }, true);

    expect(decision).toMatchObject({ allowed: false, provider: "codex", reason: "provider_runtime" });
  });

  test("a remote task's session is read through its node", async () => {
    const { allowed, baseUrl, database, nodeId } = await startNodeHub();
    await createRemoteProject(baseUrl, nodeId, join(allowed, "repo"));
    const issueId = addTodo(database, "[[late]] show me the session");
    await runProjectLoopOnce({ database, projectId: "remote-repo", providers: {} });

    const response = await adminFetch(baseUrl, `/api/sessions/codex:thread-${issueId}?include_turns=1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ provider_session_id: `thread-${issueId}`, turns: [{ id: "turn-on-node" }] });
  });

  test("model lists for a node come from that node", async () => {
    const { baseUrl, nodeId } = await startNodeHub();
    const response = await adminFetch(baseUrl, `/api/providers/codex/models?node_id=${nodeId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [{ display_name: "Node model", id: "node-model" }] });
    expect((await adminFetch(baseUrl, `/api/providers/qoder/models?node_id=${nodeId}`)).status).toBe(409);
  });

  test("provider catalogs follow the project node and allow remote-only tools while offline", async () => {
    const { agent, allowed, baseUrl, database, hub, nodeId } = await startNodeHub();
    await createRemoteProject(baseUrl, nodeId, join(allowed, "repo"));
    // 测试中心 providers={}，只有节点安装了 codex。
    expect(await (await adminFetch(baseUrl, "/api/providers")).json()).toEqual([]);
    const catalog = async (query: string) => {
      const response = await adminFetch(baseUrl, `/api/providers?${query}`);
      expect(response.status).toBe(200);
      return await response.json() as Array<Record<string, unknown>>;
    };
    const online = await catalog(`node_id=${nodeId}`);
    expect(online).toHaveLength(1);
    expect(online[0]).toMatchObject({
      id: "codex", label: "Codex", enabled: true, submittable: true,
      node_id: nodeId, node_online: true, state: "ready",
      capabilities: { issueExecution: true, models: { list: true } },
      legacy_capabilities: expect.arrayContaining(["issue_execution", "model_list"]),
      settings: { settings: expect.any(Array) }, native_actions: []
    });
    expect(await catalog("project_id=remote-repo")).toEqual(online);
    const createWork = async (eventId: string) => {
      const response = await adminFetch(baseUrl, "/api/works", {
        method: "POST",
        body: JSON.stringify({
          project_id: "remote-repo", title: eventId, goal: "Use the node tool", type: "engineering_task", status: "triage",
          audit: { actor: { id: "test", kind: "user" }, correlation_id: eventId, event_id: eventId,
            occurred_at: new Date().toISOString(), reason: "test remote selection" }
        })
      });
      expect(response.status).toBe(201);
    };
    await createWork("remote-online-create");
    agent.stop();
    await waitUntil(() => !hub.isOnline(nodeId));
    const offline = await catalog("project_id=remote-repo");
    expect(offline[0]).toMatchObject({ id: "codex", submittable: true, node_online: false, runtime: { ready: false } });
    await createWork("remote-offline-create");

    const node = getRemoteNode(database, nodeId)!;
    recordRemoteNodeHello(database, nodeId, { remoteAddr: "127.0.0.1", info: {
      ...node.info, providers: [
        ...node.info.providers,
        { id: "qoder", ready: false, capabilities: ["issue_execution"] },
        { id: "unknown-tool", ready: true, capabilities: ["issue_execution"] }
      ]
    } });
    expect((await catalog(`node_id=${nodeId}`)).map((entry) => entry.id)).toEqual(["codex", "unknown-tool"]);
    const empty = createRemoteNode(database, { name: "never reported" }).node;
    expect(await catalog(`node_id=${empty.id}`)).toEqual([]);
    expect((await adminFetch(baseUrl, "/api/providers?node_id=node_unknown")).status).toBe(404);
    expect((await adminFetch(baseUrl, "/api/providers?project_id=missing")).status).toBe(404);
    expect((await adminFetch(baseUrl, `/api/providers?project_id=remote-repo&node_id=${empty.id}`)).status).toBe(400);
    revokeRemoteNode(database, empty.id);
    expect((await adminFetch(baseUrl, `/api/providers?node_id=${empty.id}`)).status).toBe(404);
  });

  test("local projects keep using the hub's own providers", () => {
    const local: Parameters<typeof providersForProjectCwd>[0] = { codex: { id: asProviderId("codex") } };
    expect(providersForProjectCwd(local, "/srv/local-repo")).toBe(local);
    expect(providersForProjectCwd(local, "node://node_unknown:/srv/repo")).toEqual({});
  });
});
