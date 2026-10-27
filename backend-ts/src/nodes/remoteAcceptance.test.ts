import { describe, expect, test } from "bun:test";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import type { CompletionCard } from "../domain/acceptance/completionCard.ts";
import type { PiAcceptanceRuntimeResult } from "../pi/issues/issueAcceptance.ts";
import { runPiAcceptanceCoordinatorOnce } from "../runner/piAcceptanceCoordinator.ts";
import { runProjectLoopOnce } from "../runner/projectLoop.ts";
import { FIXTURE_TIME, insertIssue } from "../testing/harness.ts";
import { adminFetch, useTestNodeHub, waitUntil } from "./testing.ts";

const startNodeHub = useTestNodeHub();

function accept(): PiAcceptanceRuntimeResult {
  return decide("accept");
}

function decide(decision: "accept" | "continue_same_session" | "retry", followUp?: string): PiAcceptanceRuntimeResult {
  return {
    decision: {
      confidence: "high",
      decision,
      ...(followUp ? { follow_up_prompt: followUp } : {}),
      evidence_refs: ["run:remote"],
      progress: { evidence_refs: ["run:remote"], made_progress: true, summary: "节点上有实质进展。" },
      rationale: decision === "accept" ? "节点上的改动满足任务。" : "还需要继续处理。",
      unmet_requirements: []
    },
    raw_text: "{}",
    valid: true
  };
}

async function remoteIssueAwaitingAcceptance(startNodeHub: () => ReturnType<ReturnType<typeof useTestNodeHub>>, title: string) {
  const fixture = await startNodeHub();
  const repo = await realpath(join(fixture.allowed, "repo"));
  for (const args of [["init", "-q"], ["commit", "-q", "--allow-empty", "-m", "init"]]) {
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo });
  }
  await adminFetch(fixture.baseUrl, "/api/projects", {
    body: JSON.stringify({ auto_run: 1, cwd: repo, id: "remote-repo", node_id: fixture.nodeId, provider: "codex" }),
    method: "POST"
  });
  const issueId = insertIssue(fixture.database, { project_id: "remote-repo", status: "todo", title, updated_at: FIXTURE_TIME });
  await runProjectLoopOnce({ database: fixture.database, projectId: "remote-repo", providers: {} });
  await waitForAcceptanceRequests(fixture.database, issueId, 1);
  return { ...fixture, issueId, repo };
}

/** 运行结束后中心经节点观察 git，再登记验收请求。 */
async function waitForAcceptanceRequests(database: Parameters<typeof listIssueEvents>[0], issueId: number, count: number) {
  await waitUntil(() => listIssueEvents(database, issueId, { limit: 100, types: ["issue.pi_acceptance_requested.v1"] }).length === count, 4_000);
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

  test("a retry decision runs the issue again on the same node", async () => {
    const { database, fake, issueId } = await remoteIssueAwaitingAcceptance(startNodeHub, "[[late]] first try");

    await runPiAcceptanceCoordinatorOnce({ database, decideIssueAcceptance: async () => decide("retry"), providers: {} });

    await waitUntil(() => fake.received.length === 2, 4_000);
    expect(listIssueRuns(database, issueId)).toHaveLength(2);
    expect(listIssueRuns(database, issueId)[1]).toMatchObject({ provider: "codex" });
  });

  test("a continue decision resumes the same session on the node and is accepted afterwards", async () => {
    const { database, fake, issueId } = await remoteIssueAwaitingAcceptance(startNodeHub, "[[late]] needs another pass");

    await runPiAcceptanceCoordinatorOnce({
      database,
      decideIssueAcceptance: async () => decide("continue_same_session", "[[late]] finish the remaining part"),
      providers: {}
    });
    await waitUntil(() => fake.recovered.length === 1, 4_000);
    expect(fake.recovered[0]!.session.sessionId).toBe(`thread-${issueId}`);
    expect(fake.recovered[0]!.cwd).toBe(fake.received[0]!.cwd);

    await waitForAcceptanceRequests(database, issueId, 2);
    await runPiAcceptanceCoordinatorOnce({ database, decideIssueAcceptance: async () => accept(), providers: {} });
    expect(getIssue(database, issueId)?.status).toBe("done");
  });
});
