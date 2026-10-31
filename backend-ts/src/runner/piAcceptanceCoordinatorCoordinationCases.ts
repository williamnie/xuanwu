import { setMemoryReflectionEnabled } from "../pi/memory/memoryReflectionQueue.ts";
import { evidenceReuseFixture, reuseReport } from "../domain/acceptance/evidenceReuseTestSupport.ts";
import { expect, test } from "bun:test";

import { type CompletionCard } from "../domain/acceptance/completionCard.ts";
import { recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { createIssueRun } from "../db/repositories/issueRuns.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";

import {
  createHumanReviewRequest,
  readIssueDecisionProjection,
  reviewHumanIssue
} from "../domain/review/humanReview.ts";

import { runPiAcceptanceCoordinatorOnce } from "./piAcceptanceCoordinator.ts";

import { acceptance, fixture, completedIssue, eventTypes } from "./piAcceptanceCoordinatorTestFixtures.ts";

export function registerPiAcceptanceCoordinatorCoordinationCases() {
  for (const changed of [false, true]) test(`coordinator exposes the cross-Run chain and ${changed ? "rejects stale proof" : "avoids redundant execution"}`, async () => {
    const f = await evidenceReuseFixture();
    try {
      f.bindGitHub();
      const source = await f.run([{ command: "bun test", exit: 0 }]);
      if (changed) f.db.sqlite.run("update projects set sandbox='changed' where id='reuse'");
      await f.run([], reuseReport());
      const result = await runPiAcceptanceCoordinatorOnce({ database: f.db, decideIssueAcceptance: async card => {
        expect(card.commands.total).toBe(0);
        expect(card.prior_evidence?.items[0]).toMatchObject({ source_run_id: source.run.id,
          status: changed ? "revalidation_required" : "reusable" });
        return acceptance("accept");
      } });
      expect(result.failed).toBe(0);
      expect(getIssue(f.db, f.issue.id)?.status === "done").toBe(!changed);
      expect(listIssueRuns(f.db, f.issue.id)).toHaveLength(2);
    } finally { await f.close(); }
  });

  test("reconciles post-acceptance delivery events without invoking PI again", async () => {
    const db = await fixture();
    setMemoryReflectionEnabled(db, "demo", true);
    completedIssue(db, "Reflection recovery");
    await runPiAcceptanceCoordinatorOnce({ database: db, decideIssueAcceptance: async () => acceptance("accept") });
    db.sqlite.run("delete from pi_memory_reflections"); // 模拟验收提交后请求入库前崩溃。
    await runPiAcceptanceCoordinatorOnce({ database: db, decideIssueAcceptance: async () => { throw new Error("unexpected PI call"); } });
    expect(db.sqlite.query("select count(*) n from pi_memory_reflections").get()).toEqual({ n: 1 });
    await runPiAcceptanceCoordinatorOnce({ database: db, decideIssueAcceptance: async () => { throw new Error("unexpected PI call"); } });
    expect(db.sqlite.query("select count(*) n from pi_memory_reflections").get()).toEqual({ n: 1 });
  });

  test("calls PI once with a bounded completion card and accepts without a Verifier Issue", async () => {
    const db = await fixture();
    const issue = completedIssue(db, "Delivery");
    const seen: Array<{ issue: number; commands: number }> = [];
    const result = await runPiAcceptanceCoordinatorOnce({
      database: db,
      decideIssueAcceptance: async (card) => {
        seen.push({ issue: card.issue.id, commands: card.commands.total });
        return acceptance("accept");
      }
    });

    expect(result).toEqual({ failed: 0, issues: 1, projects: 1, skipped: 0, started: 1 });
    expect(seen).toEqual([{ issue: issue.id, commands: 0 }]);
    expect(getIssue(db, issue.id)?.status).toBe("done");
    expect(db.sqlite.query<{ count: number }, []>("select count(*) as count from issues").get()?.count).toBe(1);
    expect(eventTypes(db, issue.id)).toEqual(expect.arrayContaining([
      "issue.completion_card.v1",
      "issue.pi_acceptance_decision.v1",
      "issue.pi_acceptance_applied.v1",
      "issue.pi_lifecycle_decision.v1"
    ]));
  });

  test("does not launch PI acceptance while a human review request is open", async () => {
    const db = await fixture();
    let calls = 0;
    const issue = completedIssue(db, "Needs product choice");
    updateIssue(db, issue.id, { status: "needs_user" });
    createHumanReviewRequest(db, issue.id, { question: "是否接受当前范围？" });
    updateIssue(db, issue.id, { status: "in_progress" });
    const result = await runPiAcceptanceCoordinatorOnce({
      database: db,
      decideIssueAcceptance: async () => { calls += 1; return acceptance("accept"); }
    });
    expect(result).toMatchObject({ issues: 0, projects: 0, started: 0 });
    expect(calls).toBe(0);
    expect(getIssue(db, issue.id)?.status).toBe("needs_user");
    expect(eventTypes(db, issue.id)).toContain("issue.human_review_restored.v1");
  });

  test("regression #827: accepts the original completion after interrupting a mistaken retry without a third Run", async () => {
    const db = await fixture();
    const issue = completedIssue(db, "Provider implementation");
    const originalRun = listIssueRuns(db, issue.id)[0]!;
    await runPiAcceptanceCoordinatorOnce({
      database: db,
      decideIssueAcceptance: async () => acceptance("needs_user", "acceptance")
    });
    const request = readIssueDecisionProjection(db, issue.id).request!;
    expect(getIssue(db, issue.id)?.status).toBe("needs_user");
    expect(request.origin_card_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(request.origin_run_id).toBe(originalRun.id);
    expect(request.status).toBe("open");

    updateIssue(db, issue.id, { status: "in_progress" });
    const mistakenRun = createIssueRun(db, issue.id);
    db.sqlite.run(
      "update issue_runs set status='failed', ended_at=?, exit_reason='provider_reported_failed', error='missing turn payload' where id=?",
      ["2026-08-01T13:06:18Z", mistakenRun.id]
    );
    recordIssueEvent(db, issue.id, "run.lifecycle.outcome.v1", {
      operation: "interrupt",
      outcome: "interrupted",
      run_id: mistakenRun.id
    });
    recordIssueEvent(db, issue.id, "issue.pi_acceptance_requested.v1", {
      issue_run_id: mistakenRun.id,
      provider_outcome: "failed",
      provider_reason: "missing turn payload"
    });

    await runPiAcceptanceCoordinatorOnce({
      database: db,
      decideIssueAcceptance: async () => acceptance("accept")
    });
    expect(getIssue(db, issue.id)?.status).toBe("needs_user");

    await reviewHumanIssue(db, issue.id, {
      action: "accept",
      comment: "真实 smoke 后续由用户手动执行；接受原实现。",
      review_request_id: request.id,
      review_revision: request.revision
    });
    db.sqlite.run(
      `update issue_events
         set payload=json_remove(payload, '$.request_snapshot')
         where issue_id=? and type='issue.human_review_answered.v1'`,
      [issue.id]
    );
    let seenCard: CompletionCard | undefined;
    const result = await runPiAcceptanceCoordinatorOnce({
      database: db,
      decideIssueAcceptance: async (card) => {
        seenCard = structuredClone(card);
        return acceptance("needs_user");
      }
    });

    expect(result).toMatchObject({ failed: 0, started: 1 });
    expect(seenCard?.run.id).toBe(mistakenRun.id);
    expect(seenCard?.human_review?.action).toBe("accept");
    expect(seenCard?.human_review?.comment).toContain("接受原实现");
    expect(seenCard?.human_review?.origin_card_fingerprint).toBe(request.origin_card_fingerprint);
    expect(seenCard?.human_review?.origin_run_id).toBe(originalRun.id);
    expect(seenCard?.human_review?.origin_completion?.run.id).toBe(originalRun.id);
    expect(seenCard?.human_review?.origin_completion?.run.status).toBe("succeeded");
    expect(seenCard?.human_review?.request).toMatchObject({
      consequences: "",
      kind: "acceptance",
      question: "需要用户决定。"
    });
    expect(seenCard?.human_review?.intervening_runs.map((run) => [run.id, run.status])).toEqual([
      [mistakenRun.id, "failed"]
    ]);
    expect(seenCard?.human_review?.intervening_runs[0]).toMatchObject({
      control_operation: "interrupt",
      control_outcome: "interrupted"
    });
    expect(getIssue(db, issue.id)?.status).toBe("done");
    expect(listIssueRuns(db, issue.id)).toHaveLength(2);
    expect(eventTypes(db, issue.id)).toContain("issue.pi_human_acceptance_honored.v1");
    expect(readIssueDecisionProjection(db, issue.id).activity?.decision).toBe("accept");
  });
}
