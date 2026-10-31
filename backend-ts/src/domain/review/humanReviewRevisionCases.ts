import { expect, test } from "bun:test";

import { createIssue } from "../../db/repositories/issueCreate.ts";
import { listIssueEvents, recordIssueEvent } from "../../db/repositories/issueEvents.ts";
import { createIssueRun, updateIssueRuntime } from "../../db/repositories/issueRuns.ts";
import { getIssue, listIssueRuns } from "../../db/repositories/issues.ts";
import { updateIssue } from "../../db/repositories/issueUpdate.ts";

import {
  createHumanReviewRequest,
  readIssueDecisionProjection,
  repairRedundantAcceptedHumanReview,
  restoreOpenHumanReviewAfterTerminalRun,
  reviewHumanIssue
} from "./humanReview.ts";

import { FailingRevisionProvider, fixture } from "./humanReviewTestFixtures.ts";

export function registerHumanReviewRevisionCases() {
  test("keeps exact feedback and reopens the request when same-Session resume fails", async () => {
    const db = await fixture();
    const issue = createIssue(db, {
      project_id: "demo",
      status: "needs_user",
      title: "Retry revision"
    });
    const oldRun = createIssueRun(db, issue.id);
    updateIssueRuntime(db, issue.id, {
      issue_run_id: oldRun.id,
      provider: "codex",
      provider_session_id: "session-original",
      provider_turn_id: "turn-original"
    });
    db.sqlite.run(
      "update issue_runs set status='succeeded', ended_at=? where id=?",
      ["2026-07-31T00:00:00Z", oldRun.id]
    );
    const request = createHumanReviewRequest(db, issue.id, {
      question: "是否接受当前实现？"
    });

    await expect(reviewHumanIssue(db, issue.id, {
      action: "request_changes",
      comment: "保留原 Session 并补充失败恢复",
      review_request_id: request.id,
      review_revision: request.revision
    }, { providers: { codex: new FailingRevisionProvider() } })).rejects.toThrow("resume unavailable");

    expect(getIssue(db, issue.id)).toMatchObject({ status: "in_progress" });
    expect(readIssueDecisionProjection(db, issue.id)).toMatchObject({
      owner: "pi",
      phase: "pi_continuing",
      request: { id: request.id, status: "changes_requested" }
    });
    expect(listIssueRuns(db, issue.id).at(-1)).toMatchObject({
      error: "resume unavailable",
      exit_reason: "human_revision_resume_failed",
      status: "failed"
    });
    expect(listIssueEvents(db, issue.id, {
      types: ["issue.comment"]
    }).at(-1)?.payload).toContain("保留原 Session 并补充失败恢复");
  });

  test("restores needs_user when a later interrupted Run ends while the original review is still open", async () => {
    const db = await fixture();
    const issue = createIssue(db, {
      project_id: "demo",
      status: "needs_user",
      title: "Completed implementation awaiting acceptance"
    });
    const originalRun = createIssueRun(db, issue.id);
    db.sqlite.run(
      "update issue_runs set status='succeeded', ended_at=? where id=?",
      ["2026-08-01T11:42:06Z", originalRun.id]
    );
    const fingerprint = "a".repeat(64);
    recordIssueEvent(db, issue.id, "issue.completion_card.v1", {
      card: { run: { id: originalRun.id } },
      fingerprint
    });
    const request = createHumanReviewRequest(db, issue.id, {
      evidence_refs: [`completion-card:${fingerprint}`],
      question: "是否接受当前离线实现？"
    });
    expect(request).toMatchObject({
      origin_card_fingerprint: fingerprint,
      origin_run_id: originalRun.id
    });

    updateIssue(db, issue.id, { status: "in_progress" });
    const mistakenRun = createIssueRun(db, issue.id);
    db.sqlite.run(
      "update issue_runs set status='failed', ended_at=?, exit_reason='provider_reported_failed', error='missing turn payload' where id=?",
      ["2026-08-01T13:06:18Z", mistakenRun.id]
    );
    const statusEventsBeforeRestore = listIssueEvents(db, issue.id, {
      types: ["issue.status_changed"]
    }).length;

    expect(restoreOpenHumanReviewAfterTerminalRun(db, issue.id)).toMatchObject({ status: "needs_user" });
    expect(restoreOpenHumanReviewAfterTerminalRun(db, issue.id)).toMatchObject({ status: "needs_user" });
    expect(readIssueDecisionProjection(db, issue.id)).toMatchObject({
      owner: "human",
      request: { id: request.id, status: "open" }
    });
    expect(listIssueEvents(db, issue.id, {
      types: ["issue.human_review_restored.v1"]
    })).toHaveLength(1);
    expect(listIssueEvents(db, issue.id, {
      types: ["issue.status_changed"]
    })).toHaveLength(statusEventsBeforeRestore + 1);
  });

  test("closes a redundant acceptance request on the same terminal Run after the delivery was already accepted", async () => {
    const db = await fixture();
    const issue = createIssue(db, {
      project_id: "demo",
      status: "needs_user",
      title: "Accepted delivery was asked again"
    });
    const run = createIssueRun(db, issue.id);
    db.sqlite.run(
      "update issue_runs set status='succeeded', ended_at=? where id=?",
      ["2026-08-01T17:49:00Z", run.id]
    );
    const fingerprint = "b".repeat(64);
    recordIssueEvent(db, issue.id, "issue.completion_card.v1", {
      card: { run: { id: run.id } },
      fingerprint
    });
    const first = createHumanReviewRequest(db, issue.id, {
      consequences: "真实 smoke 未执行",
      evidence_refs: [`completion-card:${fingerprint}`],
      kind: "acceptance",
      question: "是否接受当前离线实现？"
    });
    await reviewHumanIssue(db, issue.id, {
      action: "accept",
      comment: "接受当前交付，不要求真实 smoke。",
      review_request_id: first.id,
      review_revision: first.revision
    });

    updateIssue(db, issue.id, { status: "needs_user" });
    const repeated = createHumanReviewRequest(db, issue.id, {
      consequences: "仍未执行真实 smoke",
      evidence_refs: [`completion-card:${fingerprint}`],
      kind: "acceptance",
      question: "是否提供配置再执行真实 smoke？"
    });
    expect(readIssueDecisionProjection(db, issue.id)).toMatchObject({
      owner: "human",
      request: { id: repeated.id, revision: 2, status: "open" }
    });

    expect(repairRedundantAcceptedHumanReview(db, issue.id)).toMatchObject({ status: "in_progress" });
    expect(repairRedundantAcceptedHumanReview(db, issue.id)).toMatchObject({ status: "in_progress" });
    expect(readIssueDecisionProjection(db, issue.id)).toMatchObject({
      activity: { source: "human-review-redundant-recovery", status: "queued" },
      owner: "pi",
      request: { id: repeated.id, status: "superseded" }
    });
    expect(listIssueEvents(db, issue.id, {
      types: ["issue.human_review_redundant_closed.v1"]
    })).toHaveLength(1);
    expect(listIssueRuns(db, issue.id)).toHaveLength(1);
  });
}
