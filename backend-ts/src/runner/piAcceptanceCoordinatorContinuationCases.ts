import { expect, test } from "bun:test";

import { createIssue } from "../db/repositories/issueCreate.ts";
import { buildIssueCompletionCard, recordIssueCompletionCard } from "../domain/acceptance/completionCard.ts";
import { recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { createIssueRun, updateIssueRuntime } from "../db/repositories/issueRuns.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { pausePiHeartbeat } from "../db/repositories/pi.ts";
import {
  createHumanReviewRequest,
  readIssueDecisionProjection,
  reviewHumanIssue
} from "../domain/review/humanReview.ts";
import type { PiAcceptanceRuntimeResult } from "../pi/issues/issueAcceptance.ts";

import { runPiAcceptanceCoordinatorOnce } from "./piAcceptanceCoordinator.ts";

import {
  LatestTurnProvider,
  acceptance,
  fixture,
  completedIssue,
  eventTypes
} from "./piAcceptanceCoordinatorTestFixtures.ts";

export function registerPiAcceptanceCoordinatorContinuationCases() {
  test("repairs an existing repeated acceptance request and closes it in the same coordinator cycle", async () => {
    const db = await fixture();
    let calls = 0;
    const issue = completedIssue(db, "Already accepted delivery");
    const originalCard = await buildIssueCompletionCard(db, issue.id);
    recordIssueCompletionCard(db, originalCard, "test");
    updateIssue(db, issue.id, { status: "needs_user" });
    const accepted = createHumanReviewRequest(db, issue.id, {
      consequences: "真实 smoke 未执行",
      evidence_refs: [`completion-card:${originalCard.fingerprint}`],
      kind: "acceptance",
      question: "是否接受当前离线实现？"
    });
    await reviewHumanIssue(db, issue.id, {
      action: "accept",
      comment: "接受当前交付，不要求真实 smoke。",
      review_request_id: accepted.id,
      review_revision: accepted.revision
    });
    updateIssue(db, issue.id, { status: "needs_user" });
    const repeated = createHumanReviewRequest(db, issue.id, {
      consequences: "仍未执行真实 smoke",
      evidence_refs: [`completion-card:${originalCard.fingerprint}`],
      kind: "acceptance",
      question: "是否提供配置再执行真实 smoke？"
    });

    const result = await runPiAcceptanceCoordinatorOnce({
      database: db,
      decideIssueAcceptance: async () => {
        calls += 1;
        return acceptance("needs_user");
      }
    });

    expect(result).toMatchObject({ failed: 0, issues: 1, started: 1 });
    expect(calls).toBe(1);
    expect(getIssue(db, issue.id)?.status).toBe("done");
    expect(readIssueDecisionProjection(db, issue.id)).toMatchObject({
      owner: "pi",
      phase: "complete",
      request: { id: repeated.id, status: "superseded" }
    });
    expect(eventTypes(db, issue.id)).toContain("issue.human_review_redundant_closed.v1");
    expect(listIssueRuns(db, issue.id)).toHaveLength(1);
  });

  test("respects an explicit project heartbeat pause", async () => {
    const db = await fixture();
    let calls = 0;
    completedIssue(db, "Paused");
    pausePiHeartbeat(db, { reason: "maintenance", scopeId: "demo", scopeType: "project" });
    const result = await runPiAcceptanceCoordinatorOnce({
      database: db,
      decideIssueAcceptance: async () => { calls += 1; return acceptance("accept"); }
    });
    expect(result).toMatchObject({ issues: 0, started: 0 });
    expect(calls).toBe(0);
  });

  test("keeps retrying PI infrastructure failures without changing Issue semantics", async () => {
    const db = await fixture();
    let calls = 0;
    const issue = completedIssue(db, "Broken PI RPC");
    const run = () => runPiAcceptanceCoordinatorOnce({
      cooldownMs: 0,
      database: db,
      decideIssueAcceptance: async () => {
        calls += 1;
        throw new Error("agentic RPC unavailable");
      },
      now: new Date(`2026-07-31T05:0${calls}:30Z`)
    });
    expect((await run()).failed).toBe(1);
    expect((await run()).failed).toBe(1);
    expect((await run()).failed).toBe(1);
    expect(calls).toBe(3);
    expect(getIssue(db, issue.id)?.status).toBe("in_progress");
    expect(readIssueDecisionProjection(db, issue.id)).toMatchObject({ owner: "pi", phase: "pi_error" });
    expect(eventTypes(db, issue.id).filter((type) => type === "issue.pi_acceptance_runtime_failed.v1")).toHaveLength(3);
    expect(eventTypes(db, issue.id).filter((type) => type === "issue.pi_acceptance_started.v1")).toHaveLength(3);
  });

  test("treats invalid PI schema as a system failure, never as needs_user", async () => {
    const db = await fixture();
    const issue = completedIssue(db, "Invalid PI response");
    const run = () => runPiAcceptanceCoordinatorOnce({
      cooldownMs: 0,
      database: db,
      decideIssueAcceptance: async (): Promise<PiAcceptanceRuntimeResult> => ({
        error: "PI acceptance returned invalid JSON or schema",
        raw_text: "not-json",
        valid: false
      }),
      now: new Date("2026-07-31T05:09:30Z")
    });

    expect((await run()).failed).toBe(1);
    expect((await run()).failed).toBe(1);
    expect(readIssueDecisionProjection(db, issue.id)).toMatchObject({ owner: "pi", phase: "pi_error" });
    expect(eventTypes(db, issue.id)).not.toContain("issue.human_review_requested.v1");
    expect(eventTypes(db, issue.id)).not.toContain("issue.pi_acceptance_decision.v1");
  });

  test("does not schedule PI before a canonical Run reaches terminal state", async () => {
    const db = await fixture();
    let calls = 0;
    const issue = createIssue(db, { project_id: "demo", status: "in_progress", title: "Missing terminal Run" });
    const openRun = createIssueRun(db, issue.id);
    recordIssueEvent(db, issue.id, "issue.pi_acceptance_requested.v1", { issue_run_id: openRun.id });
    const run = () => runPiAcceptanceCoordinatorOnce({
      cooldownMs: 0,
      database: db,
      decideIssueAcceptance: async () => { calls += 1; return acceptance("accept"); },
      now: new Date("2026-07-31T05:10:00Z")
    });

    expect((await run()).issues).toBe(0);
    expect((await run()).issues).toBe(0);
    expect(calls).toBe(0);
    expect(eventTypes(db, issue.id)).not.toContain("issue.pi_acceptance_runtime_failed.v1");
  });

  test("regression #821: reads the latest Provider Session Turn before judging a stale canonical Run", async () => {
    const db = await fixture();
    const provider = new LatestTurnProvider();
    let seenLatestTurn = "";
    const issue = completedIssue(db, "Implementation continued outside the terminal Run");
    const run = listIssueRuns(db, issue.id)[0]!;
    updateIssueRuntime(db, issue.id, {
      issue_run_id: run.id,
      provider: "codex",
      provider_session_id: "019fbb19-ff89-75c3-b4ec-b9562359cf16",
      provider_turn_id: "019fbb1a-134b-7da1-ba36-9725d960c543"
    });

    const result = await runPiAcceptanceCoordinatorOnce({
      database: db,
      decideIssueAcceptance: async (card) => {
        seenLatestTurn = card.session.latest_turn_id;
        expect(card.session).toMatchObject({
          inspected: true,
          latest_turn_id: "019fbb3c-886f-74d0-a834-2d488e237a5d",
          latest_turn_matches_run: false,
          run_turn_id: "019fbb1a-134b-7da1-ba36-9725d960c543",
          turn_count: 2
        });
        expect(card.session.latest_turn_items).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: "agentMessage", text: expect.stringContaining("实现和验证已经完成") }),
          expect.objectContaining({ command: expect.stringContaining("custom-check"), exit_code: 0 })
        ]));
        expect(card.session.current_git).toMatchObject({
          observed_at: "2026-07-31T05:02:00.000Z",
          source: "session_observation"
        });
        return acceptance("accept");
      },
      providers: { codex: provider }
    });

    expect(result).toMatchObject({ failed: 0, started: 1 });
    expect(seenLatestTurn).toBe("019fbb3c-886f-74d0-a834-2d488e237a5d");
    expect(getIssue(db, issue.id)?.status).toBe("done");
  });
}
