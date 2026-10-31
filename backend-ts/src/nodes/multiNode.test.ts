import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { listIssueRuns } from "../db/repositories/issues.ts";
import { createRemoteNode } from "../db/repositories/nodes.ts";
import { setProjectLoopMaxParallelProjects, startProjectLoop } from "../runner/projectLoopManager.ts";
import { FIXTURE_TIME, insertIssue, insertProject } from "../testing/harness.ts";
import { adminFetch, fakeNodeProvider, useNodeHubProcesses, waitUntil } from "./testing.ts";

const { startHub, startNode, tempDir } = useNodeHubProcesses();

afterEach(() => setProjectLoopMaxParallelProjects(1));

describe("one hub driving several nodes", () => {
  test("each node and the hub run work in parallel within their own limits", async () => {
    const { allowed, database, root } = await tempDir();
    setProjectLoopMaxParallelProjects(1);
    // 中心本机也有一个项目，用本机 provider 执行。
    const local = fakeNodeProvider();
    await mkdir(join(root, "local-repo"));
    insertProject(database, "local-repo", { cwd: join(root, "local-repo"), provider: "codex", auto_run: 1 });
    const hub = startHub(database, 0, undefined, { codex: local.provider });

    const nodes = [];
    for (const [name, maxParallel] of [["a", 1], ["b", 2]] as const) {
      const { node, token } = createRemoteNode(database, { name });
      const nodeRoot = join(allowed, name);
      await mkdir(join(nodeRoot, "one"), { recursive: true });
      await mkdir(join(nodeRoot, "two"), { recursive: true });
      const process = startNode(hub.baseUrl, token, nodeRoot, maxParallel);
      await waitUntil(() => hub.hub.isOnline(node.id));
      for (const project of ["one", "two"]) {
        await adminFetch(hub.baseUrl, "/api/projects", {
          body: JSON.stringify({ auto_run: 1, cwd: await realpath(join(nodeRoot, project)), id: `${name}-${project}`, node_id: node.id, provider: "codex" }),
          method: "POST"
        });
      }
      nodes.push({ ...process, id: node.id, name });
    }
    const projects = ["local-repo", "a-one", "a-two", "b-one", "b-two"];
    const issues = projects.map((project) => insertIssue(database, {
      project_id: project, status: "todo", title: `[[wait]] work in ${project}`, updated_at: FIXTURE_TIME
    }));

    for (const project of projects) startProjectLoop({ database, providers: { codex: local.provider } }, project);

    // 本机 1 个 + 节点 a 1 个 + 节点 b 2 个 = 4 个任务同时执行；节点 a 的第二个项目排队等待名额。
    const [nodeA, nodeB] = [nodes.find((node) => node.name === "a")!, nodes.find((node) => node.name === "b")!];
    await waitUntil(() => local.received.length === 1 && nodeA.fake.received.length === 1 && nodeB.fake.received.length === 2, 4_000);
    // 再等一会，确认节点 a 不会超出自己的名额。
    await Bun.sleep(300);
    expect(nodeA.fake.received).toHaveLength(1);
    const running = issues.filter((issue) => listIssueRuns(database, issue).some((run) => run.ended_at === ""));
    expect(running).toHaveLength(4);
  });
});
