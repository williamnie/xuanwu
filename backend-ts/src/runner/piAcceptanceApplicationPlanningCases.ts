import { expect, test } from "bun:test";

import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { buildIssueCompletionCard, recordIssueCompletionCard } from "../domain/acceptance/completionCard.ts";
import {
  createHumanReviewRequest,
  readIssueDecisionProjection,
  reviewHumanIssue
} from "../domain/review/humanReview.ts";

import { applyPiAcceptanceDecision } from "./piAcceptanceApplication.ts";

import {
  ContinuingProvider,
  FreshSessionProvider,
  fixture,
  completedIssue,
  continuationStreaks,
  decision
} from "./piAcceptanceApplicationTestFixtures.ts";

export function registerPiAcceptanceApplicationPlanningCases() {
  test("pauses same-session continuation and notifies the user after three no-progress Runs", async () => {
    const db = await fixture();
    const provider = new ContinuingProvider();
    const published: Array<{ type: string }> = [];
    const issue = completedIssue(db, "No-progress loop", "session-loop", "turn-1");
    const runtime = {
      bus: { publish: (event: { type: string }) => published.push(event) },
      database: db,
      providers: { codex: provider }
    };

    for (let index = 0; index < 2; index += 1) {
      const card = await buildIssueCompletionCard(db, issue.id);
      const updated = await applyPiAcceptanceDecision(
        runtime,
        card,
        decision("continue_same_session", "继续完成实现。", undefined, false)
      );
      expect(updated.status).toBe("in_progress");
    }
    const thirdCard = await buildIssueCompletionCard(db, issue.id);
    const updated = await applyPiAcceptanceDecision(
      runtime,
      thirdCard,
      decision("continue_same_session", "继续完成实现。", undefined, false)
    );

    expect(updated.status).toBe("needs_user");
    expect(provider.inputs).toHaveLength(2);
    expect(listIssueRuns(db, issue.id)).toHaveLength(3);
    expect(readIssueDecisionProjection(db, issue.id)).toMatchObject({
      owner: "human",
      phase: "human_review",
      request: { kind: "decision" }
    });
    expect(published).toContainEqual(expect.objectContaining({ type: "pi.needs_user" }));
    expect(continuationStreaks(db, issue.id)).toEqual([1, 2, 3]);
  });

  test("resets the no-progress streak when PI observes meaningful progress", async () => {
    const db = await fixture();
    const provider = new ContinuingProvider();
    const issue = completedIssue(db, "Progressing loop", "session-progress", "turn-1");
    const runtime = { database: db, providers: { codex: provider } };
    for (const madeProgress of [false, true, false]) {
      const card = await buildIssueCompletionCard(db, issue.id);
      const updated = await applyPiAcceptanceDecision(
        runtime,
        card,
        decision("continue_same_session", "继续完成实现。", undefined, madeProgress)
      );
      expect(updated.status).toBe("in_progress");
    }

    expect(provider.inputs).toHaveLength(3);
    expect(listIssueRuns(db, issue.id)).toHaveLength(4);
    expect(continuationStreaks(db, issue.id)).toEqual([1, 0, 1]);
  });

  test("does not race past an open human review request", async () => {
    const db = await fixture();
    const issue = completedIssue(db, "Human owned");
    updateIssue(db, issue.id, { status: "needs_user" });
    createHumanReviewRequest(db, issue.id, { question: "请确认产品范围。" });
    updateIssue(db, issue.id, { status: "in_progress" });
    const card = await buildIssueCompletionCard(db, issue.id);

    await expect(applyPiAcceptanceDecision({ database: db }, card, decision("accept")))
      .rejects.toThrow("cannot bypass an open human review request");
    expect(getIssue(db, issue.id)?.status).toBe("in_progress");
  });

  test("does not treat acceptance of a bounded product decision as terminal delivery acceptance", async () => {
    const db = await fixture();
    const issue = completedIssue(db, "Product decision only");
    const originCard = await buildIssueCompletionCard(db, issue.id);
    recordIssueCompletionCard(db, originCard, "test");
    updateIssue(db, issue.id, { status: "needs_user" });
    const request = createHumanReviewRequest(db, issue.id, {
      evidence_refs: [`completion-card:${originCard.fingerprint}`],
      kind: "decision",
      question: "是否选择方案 A？"
    });
    await reviewHumanIssue(db, issue.id, {
      action: "accept",
      comment: "选择方案 A。",
      review_request_id: request.id,
      review_revision: request.revision
    });
    const card = await buildIssueCompletionCard(db, issue.id);

    const updated = await applyPiAcceptanceDecision(
      { database: db },
      card,
      decision("needs_user", "还需要另一个独立产品决定。")
    );

    expect(updated.status).toBe("needs_user");
    expect(readIssueDecisionProjection(db, issue.id)).toMatchObject({
      owner: "human",
      request: { kind: "decision", revision: 2, status: "open" }
    });
    expect(db.sqlite.query<{ count: number }, [number]>(
      "select count(*) as count from issue_events where issue_id=? and type='issue.pi_human_acceptance_honored.v1'"
    ).get(issue.id)?.count).toBe(0);
  });

  for (const action of ["continue_same_session", "retry"] as const) {
    test(`Q7 authorization survives ${action} without accepting delivery or widening its scope`, async () => {
      const db = await fixture();
      const provider = action === "retry" ? new FreshSessionProvider() : new ContinuingProvider();
      const issue = completedIssue(db, "Qoder Q7：安装登录与真实账号最终验收", "q7-codex-session", "q7-blocked-turn");
      const originCard = await buildIssueCompletionCard(db, issue.id);
      await applyPiAcceptanceDecision(
        { database: db },
        originCard,
        decision(
          "needs_user",
          "请授权安装、登录和真实付费测试，并提供认证方式及预算上限。",
          "risk_acceptance"
        )
      );
      const request = readIssueDecisionProjection(db, issue.id).request!;
      expect(request).toMatchObject({ kind: "risk_acceptance", status: "open" });

      await reviewHumanIssue(db, issue.id, {
        action: "accept",
        comment: "授权真实测试；认证使用已登录的 local-cli；MAX_PAID_TURNS=10；MAX_CREDITS=3。",
        review_request_id: request.id,
        review_revision: request.revision
      });
      const answeredCard = await buildIssueCompletionCard(db, issue.id);
      const updated = await applyPiAcceptanceDecision(
        { database: db, providers: { codex: provider } },
        answeredCard,
        decision(action, "按已授权预算继续 Q7 真实验收。")
      );

      expect(updated.status).toBe("in_progress");
      expect(provider.inputs).toHaveLength(1);
      if (action === "continue_same_session") {
        expect(provider.inputs[0]).toMatchObject({
          session: { provider: "codex", sessionId: "q7-codex-session", turnId: "q7-blocked-turn" }
        });
      }
      expect(provider.inputs[0]?.prompt).toContain("已认证的人类回复类型：risk_acceptance");
      expect(provider.inputs[0]?.prompt).toContain("已认证的人类回复动作：accept");
      expect(provider.inputs[0]?.prompt).toContain("MAX_PAID_TURNS=10；MAX_CREDITS=3");
      expect(provider.inputs[0]?.prompt).toContain("release or paid-operation gates remain binding");
      expect(listIssueRuns(db, issue.id)).toMatchObject([
        { attempt: 1, provider_session_id: "q7-codex-session", provider_turn_id: "q7-blocked-turn" },
        { attempt: 2, provider_session_id: action === "retry" ? "session-fresh" : "q7-codex-session",
          provider_turn_id: action === "retry" ? "turn-fresh" : "turn-next" }
      ]);
      expect(db.sqlite.query<{ count: number }, [number]>(
        "select count(*) as count from issue_events where issue_id=? and type='issue.pi_human_acceptance_honored.v1'"
      ).get(issue.id)?.count).toBe(0);
    });
  }
}
