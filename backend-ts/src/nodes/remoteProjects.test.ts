import { describe, expect, test } from "bun:test";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { cancelIssueWithInterrupt } from "../runner/interrupt.ts";
import { projectLoopDecision, runProjectLoopOnce } from "../runner/projectLoop.ts";
import { FIXTURE_TIME, insertIssue } from "../testing/harness.ts";
import { adminFetch, useTestNodeHub, waitUntil } from "./testing.ts";
import { providersForProjectCwd } from "./remoteExecution.ts";
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

  test("local projects keep using the hub's own providers", () => {
    const local: Parameters<typeof providersForProjectCwd>[0] = { codex: { id: asProviderId("codex") } };
    expect(providersForProjectCwd(local, "/srv/local-repo")).toBe(local);
    expect(providersForProjectCwd(local, "node://node_unknown:/srv/repo")).toEqual({});
  });
});
