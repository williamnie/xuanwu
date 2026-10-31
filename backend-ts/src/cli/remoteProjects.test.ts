import { expect, test } from "bun:test";
import { join } from "node:path";
import { createProject } from "../db/repositories/projects.ts";
import { createRemoteNode } from "../db/repositories/nodes.ts";
import { TEST_ADMIN_TOKEN, useTestNodeHub } from "../nodes/testing.ts";
import { runCli } from "./command.ts";

const start = useTestNodeHub();

async function run(baseUrl: string, args: string[], token = TEST_ADMIN_TOKEN) {
  let stdout = "";
  let stderr = "";
  const env: Record<string, string> = { XUANWU_ADDR: baseUrl, XUANWU_AUTH_TOKEN: token };
  const code = await runCli(args, { write: text => { stdout += text; } }, { write: text => { stderr += text; } }, {
    env: key => env[key]
  });
  return { code, stdout, stderr };
}

test("authenticated CLI creates remote projects and lists local/remote locations and nodes", async () => {
  const { baseUrl, allowed, nodeId, database } = await start();
  createProject(database, { id: "repo", name: "Local", cwd: allowed });
  const args = ["project", "create", "--cwd", join(allowed, "repo"), "--node-id", nodeId, "--json"];
  const created = await run(baseUrl, args);
  expect(created.code).toBe(0);
  const project = JSON.parse(created.stdout);
  expect(project.id).toMatch(/^repo-[a-f0-9]{8}$/);
  expect(project.node_id).toBe(nodeId);
  expect((await run(baseUrl, args)).code).toBe(0);

  const listed = await run(baseUrl, ["project", "list", "--json"]);
  expect(listed.code).toBe(0);
  const rows = JSON.parse(listed.stdout);
  expect(rows).toHaveLength(2);
  expect(rows.find((row: { id: string }) => row.id === "repo")).toMatchObject({ location: allowed, node_id: "" });
  expect(rows.find((row: { id: string }) => row.id === project.id)).toMatchObject({
    location: `laptop:${project.node_path}`, node_id: nodeId
  });
  const human = await run(baseUrl, ["project", "list"]);
  expect(human.stdout).toContain(`laptop:${project.node_path}`);
  expect(human.stdout).toContain("Local");

  const offline = createRemoteNode(database, { name: "offline-node" }).node;
  const nodes = await run(baseUrl, ["node", "list", "--json"]);
  expect(nodes.code).toBe(0);
  expect(JSON.parse(nodes.stdout).nodes).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: nodeId, online: true }),
    expect.objectContaining({ id: offline.id, online: false })
  ]));
  const summary = await run(baseUrl, ["node", "list"]);
  expect(summary.stdout).toContain("laptop\tonline\tcodex\ttest");
  expect(summary.stdout).toContain("offline-node\toffline");

  const process = Bun.spawn([Bun.which("bun")!, "run", "src/main.ts", "node", "list", "--addr", baseUrl, "--token", TEST_ADMIN_TOKEN, "--json"], {
    cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe"
  });
  const output = await new Response(process.stdout).text();
  expect(await process.exited).toBe(0);
  expect(JSON.parse(output).nodes).toHaveLength(2);
});

test("explicit remote ID is retained and path-check precedes creation", async () => {
  const { baseUrl, allowed, nodeId } = await start();
  const result = await run(baseUrl, ["project", "create", "--node-id", nodeId, "--cwd", join(allowed, "repo"), "--id", "chosen", "--json"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).id).toBe("chosen");
});

test("invalid nodes, disallowed/missing paths and authentication fail clearly without creation", async () => {
  const { baseUrl, allowed, nodeId } = await start();
  for (const [id, cwd, message] of [
    ["node_unknown", "/x", "节点不存在"],
    [nodeId, "/etc", "outside the node's allowed roots"],
    [nodeId, join(allowed, "missing"), "节点上不存在该文件夹"]
  ]) {
    const result = await run(baseUrl, ["project", "create", "--node-id", id!, "--cwd", cwd!, "--id", "bad"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message!);
  }
  for (const args of [["node", "list"], ["project", "list"], ["project", "create", "--node-id", nodeId, "--cwd", allowed]]) {
    const result = await run(baseUrl, args, "wrong");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("401");
  }
  expect(JSON.parse((await run(baseUrl, ["project", "list", "--json"])).stdout)).toEqual([]);
});
