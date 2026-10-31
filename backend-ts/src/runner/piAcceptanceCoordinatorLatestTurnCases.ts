import { expect, test } from "bun:test";

import { createIssue } from "../db/repositories/issueCreate.ts";

import { updateIssueRuntime } from "../db/repositories/issueRuns.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";

import type { PiAcceptanceRuntimeResult } from "../pi/issues/issueAcceptance.ts";

import { runPiAcceptanceCoordinatorOnce } from "./piAcceptanceCoordinator.ts";

import {
  NextIssueProvider,
  CoordinatorContinuationProvider,
  acceptance,
  fixture,
  completedIssue,
  waitFor
} from "./piAcceptanceCoordinatorTestFixtures.ts";

export function registerPiAcceptanceCoordinatorLatestTurnCases() {
  test("re-evaluates the fresh card after same-session continuation finishes", async () => {
    const db = await fixture();
    const provider = new CoordinatorContinuationProvider();
    let calls = 0;
    const issue = completedIssue(db, "Continue then accept");
    const firstRun = listIssueRuns(db, issue.id)[0]!;
    updateIssueRuntime(db, issue.id, {
      issue_run_id: firstRun.id,
      provider: "codex",
      provider_session_id: "session-original",
      provider_turn_id: "turn-original"
    });
    const decide = async (): Promise<PiAcceptanceRuntimeResult> => {
      calls += 1;
      return calls === 1
        ? {
          decision: {
            confidence: "high",
            decision: "continue_same_session",
            evidence_refs: ["run:fixture"],
            follow_up_prompt: "补一项真实验证。",
            progress: { made_progress: true, evidence_refs: ["run:fixture"], summary: "已完成部分实现。" },
            rationale: "还缺少一项验证。",
            unmet_requirements: ["真实验证"]
          },
          raw_text: "{}",
          valid: true
        }
        : acceptance("accept");
    };

    await runPiAcceptanceCoordinatorOnce({
      cooldownMs: 0,
      database: db,
      decideIssueAcceptance: decide,
      providers: { codex: provider }
    });
    expect(getIssue(db, issue.id)?.status).toBe("in_progress");
    await runPiAcceptanceCoordinatorOnce({
      cooldownMs: 0,
      database: db,
      decideIssueAcceptance: decide,
      providers: { codex: provider }
    });

    expect(calls).toBe(2);
    expect(getIssue(db, issue.id)?.status).toBe("done");
    expect(listIssueRuns(db, issue.id)).toHaveLength(2);
    expect(provider.inputs[0]?.session.sessionId).toBe("session-original");
    expect(db.sqlite.query<{ count: number }, []>("select count(*) as count from issues").get()?.count).toBe(1);
  });

  test("accepting one Issue releases the project lock and starts the next ready Issue", async () => {
    const db = await fixture();
    const provider = new NextIssueProvider();
    const first = completedIssue(db, "First delivery");
    const second = createIssue(db, { project_id: "demo", status: "todo", title: "Second delivery" });

    await runPiAcceptanceCoordinatorOnce({
      database: db,
      decideIssueAcceptance: async () => acceptance("accept"),
      providers: { codex: provider }
    });
    await waitFor(() => provider.inputs.some((input) => input.issueId === second.id));

    expect(getIssue(db, first.id)?.status).toBe("done");
    expect(getIssue(db, second.id)).toMatchObject({ status: "in_progress", attempt_count: 1 });
  });
}
