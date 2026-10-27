import { describe, expect, test } from "bun:test";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { getIssue } from "../db/repositories/issues.ts";
import type { CompletionCard } from "../domain/acceptance/completionCard.ts";
import type { PiAcceptanceRuntimeResult } from "../pi/issues/issueAcceptance.ts";
import { runPiAcceptanceCoordinatorOnce } from "../runner/piAcceptanceCoordinator.ts";
import { runProjectLoopOnce } from "../runner/projectLoop.ts";
import { FIXTURE_TIME, insertIssue } from "../testing/harness.ts";
import { adminFetch, useTestNodeHub, waitUntil } from "./testing.ts";

const startNodeHub = useTestNodeHub();

function accept(): PiAcceptanceRuntimeResult {
  return {
    decision: {
      confidence: "high",
      decision: "accept",
      evidence_refs: ["run:remote"],
      progress: { evidence_refs: ["run:remote"], made_progress: true, summary: "节点上的改动满足任务。" },
      rationale: "节点上的改动满足任务。",
      unmet_requirements: []
    },
    raw_text: "{}",
    valid: true
  };
}

describe("unattended acceptance of remote work", () => {
  test("the hub accepts a node's run from git evidence and the session read on the node", async () => {
    const { allowed, baseUrl, database, nodeId } = await startNodeHub();
    const repo = await realpath(join(allowed, "repo"));
    for (const args of [["init", "-q"], ["commit", "-q", "--allow-empty", "-m", "init"]]) {
      Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo });
    }
    await writeFile(join(repo, ".gitignore"), "");
    await adminFetch(baseUrl, "/api/projects", {
      body: JSON.stringify({ auto_run: 1, cwd: repo, id: "remote-repo", node_id: nodeId, provider: "codex" }),
      method: "POST"
    });
    const issueId = insertIssue(database, { project_id: "remote-repo", status: "todo", title: "[[edit]] [[late]] add a file", updated_at: FIXTURE_TIME });

    await runProjectLoopOnce({ database, projectId: "remote-repo", providers: {} });
    // 运行结束后中心经节点观察 git，再登记验收请求。
    await waitUntil(() => listIssueEvents(database, issueId, { limit: 100, types: ["issue.pi_acceptance_requested.v1"] }).length === 1);

    let reviewed: CompletionCard | undefined;
    const result = await runPiAcceptanceCoordinatorOnce({
      database,
      decideIssueAcceptance: async (card) => {
        reviewed = card;
        return accept();
      },
      providers: {}
    });

    expect(result).toMatchObject({ failed: 0, started: 1 });
    expect(reviewed?.git.changed_files).toContain("edited.txt");
    // 会话摘要经节点读取，而不是用中心本机的 provider。
    expect(reviewed?.session).toMatchObject({ inspected: true, latest_turn_id: "turn-on-node" });
    expect(getIssue(database, issueId)?.status).toBe("done");
  });
});
