import { describe, expect, test } from "bun:test";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listIssueRuns } from "../db/repositories/issues.ts";
import { buildIssueCompletionCard } from "../domain/acceptance/completionCard.ts";
import { createLocalGitAdapter } from "../domain/git/adapter.ts";
import { observeGitWorkspaceBaseline } from "../domain/run/gitWorkspaceObservation.ts";
import { runProjectLoopOnce } from "../runner/projectLoop.ts";
import { FIXTURE_TIME, insertIssue } from "../testing/harness.ts";
import { remoteProjectCwd } from "./projectLocation.ts";
import { adminFetch, useTestNodeHub, waitUntil } from "./testing.ts";

const startNodeHub = useTestNodeHub();

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

async function hubWithRepo() {
  const fixture = await startNodeHub();
  const repo = await realpath(join(fixture.allowed, "repo"));
  git(repo, "init", "-q");
  await writeFile(join(repo, "README.md"), "hello\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "init");
  return { ...fixture, cwd: remoteProjectCwd(fixture.nodeId, repo), head: git(repo, "rev-parse", "HEAD"), repo };
}

describe("remote git for hub-side acceptance", () => {
  test("workspace baselines are observed on the node", async () => {
    const { cwd, head, repo } = await hubWithRepo();
    await writeFile(join(repo, "README.md"), "changed\n");
    await writeFile(join(repo, "new.txt"), "new\n");

    const baseline = await observeGitWorkspaceBaseline({ project_cwd: cwd, run_id: "run-1" });

    expect(baseline?.base_revision).toBe(head);
    expect(baseline?.entries.map((entry) => entry.path).sort()).toEqual(["README.md", "new.txt"]);
  });

  test("the evidence git adapter reads through the node and refuses writes", async () => {
    const { cwd, head } = await hubWithRepo();
    const adapter = createLocalGitAdapter();

    const result = await adapter.run({ args: ["rev-parse", "--verify", "HEAD^{commit}"], repository_path: cwd });
    expect(result.stdout.toString().trim()).toBe(head);
    await expect(adapter.run({ args: ["commit", "-m", "x"], repository_path: cwd })).rejects.toThrow("not allowed on nodes");
    await expect(adapter.run({ args: ["hash-object", "-w", "README.md"], repository_path: cwd })).rejects.toThrow("not allowed on nodes");
    await expect(adapter.run({ args: ["status"], identity: { email: "a@b.c", name: "a" }, repository_path: cwd })).rejects.toThrow("read-only");
    // 退出码不在允许范围内时与本机一致地报错。
    await expect(adapter.run({ args: ["rev-parse", "--verify", "missing-ref"], repository_path: cwd })).rejects.toThrow("failed with exit");
  });

  test("paths outside the node's roots are refused and an offline node reads as unavailable", async () => {
    const { agent, hub, nodeId } = await hubWithRepo();
    expect(await observeGitWorkspaceBaseline({ project_cwd: remoteProjectCwd(nodeId, "/etc"), run_id: "run-1" })).toBeNull();
    agent.stop();
    await waitUntil(() => !hub.isOnline(nodeId));
    await expect(createLocalGitAdapter().run({ args: ["status"], repository_path: remoteProjectCwd(nodeId, "/tmp") }))
      .rejects.toThrow("remote node git is unavailable");
  });

  test("the hub's completion card sees the changes the run made on the node", async () => {
    const { baseUrl, database, nodeId, repo } = await hubWithRepo();
    await adminFetch(baseUrl, "/api/projects", {
      body: JSON.stringify({ cwd: repo, id: "remote-repo", node_id: nodeId, provider: "codex" }),
      method: "POST"
    });
    const issueId = insertIssue(database, { project_id: "remote-repo", status: "todo", title: "[[edit]] [[late]] change it", updated_at: FIXTURE_TIME });

    await runProjectLoopOnce({ database, projectId: "remote-repo", providers: {} });
    await waitUntil(() => listIssueRuns(database, issueId)[0]?.ended_at !== "");
    const card = await buildIssueCompletionCard(database, issueId);

    expect(card.git.changed_files).toContain("edited.txt");
  });

  test("a remote issue run records its git base revision like a local one", async () => {
    const { baseUrl, database, head, nodeId, repo } = await hubWithRepo();
    await adminFetch(baseUrl, "/api/projects", {
      body: JSON.stringify({ cwd: repo, id: "remote-repo", node_id: nodeId, provider: "codex" }),
      method: "POST"
    });
    const issueId = insertIssue(database, { project_id: "remote-repo", status: "todo", title: "change it", updated_at: FIXTURE_TIME });

    await runProjectLoopOnce({ database, projectId: "remote-repo", providers: {} });

    expect(listIssueRuns(database, issueId)[0]?.git_base_revision).toBe(head);
  });
});
