import { expect, test } from "bun:test";

import { recordIssueEvent } from "../db/repositories/issueEvents.ts";

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
  selectProviderDefaultProfile,
  decision
} from "./piAcceptanceApplicationTestFixtures.ts";

export function registerPiAcceptanceApplicationContinuationCases() {
  test("PI retry creates a fresh Provider Session and a new canonical Run", async () => {
    const db = await fixture();
    const provider = new FreshSessionProvider("claude");
    const issue = completedIssue(db, "Retry delivery", "session-broken", "turn-broken", "claude");
    selectProviderDefaultProfile(db, issue.id, "claude");
    const card = await buildIssueCompletionCard(db, issue.id);
    const updated = await applyPiAcceptanceDecision(
      { database: db, providers: { claude: provider } },
      card,
      decision("retry", "原 Session 已损坏，读取工作区后从剩余步骤继续。")
    );

    expect(provider.inputs).toHaveLength(1);
    expect(provider.inputs[0]?.model).toBe("");
    expect(provider.inputs[0]?.prompt).toContain("原 Session 已损坏");
    expect(provider.inputs[0]?.prompt).toContain("新 Session");
    expect(provider.inputs[0]?.prompt).toContain("不要因为任务是对话或没有仓库改动而使用 needs_user");
    expect(updated.status).toBe("in_progress");
    expect(listIssueRuns(db, issue.id)).toMatchObject([
      { attempt: 1, provider_session_id: "session-broken" },
      { attempt: 2, provider_session_id: "session-fresh", provider_turn_id: "turn-fresh", status: "succeeded" }
    ]);
  });

  test("stops automatic fresh-session retries at the safety limit", async () => {
    const db = await fixture();
    const provider = new FreshSessionProvider();
    const issue = completedIssue(db, "Retry guard", "session-latest", "turn-latest");
    recordIssueEvent(db, issue.id, "issue.pi_acceptance_applied.v1", { action: "retry", run_id: "old-1" });
    recordIssueEvent(db, issue.id, "issue.pi_acceptance_applied.v1", { action: "retry", run_id: "old-2" });
    const card = await buildIssueCompletionCard(db, issue.id);

    const updated = await applyPiAcceptanceDecision(
      { database: db, providers: { codex: provider } },
      card,
      decision("retry", "再开一个 Session 重试。")
    );

    expect(updated.status).toBe("needs_user");
    expect(provider.inputs).toHaveLength(0);
    expect(listIssueRuns(db, issue.id)).toHaveLength(1);
    expect(readIssueDecisionProjection(db, issue.id)).toMatchObject({
      owner: "human",
      phase: "human_review"
    });
  });

  test("accepted delivery review blocks PI retry from creating another Provider Session", async () => {
    const db = await fixture();
    const provider = new FreshSessionProvider();
    const issue = completedIssue(db, "Accepted delivery", "session-original", "turn-original");
    const originCard = await buildIssueCompletionCard(db, issue.id);
    recordIssueCompletionCard(db, originCard, "test");
    updateIssue(db, issue.id, { status: "needs_user" });
    const request = createHumanReviewRequest(db, issue.id, {
      consequences: "真实 smoke 未执行",
      evidence_refs: [`completion-card:${originCard.fingerprint}`],
      kind: "acceptance",
      question: "是否接受当前离线实现？"
    });
    await reviewHumanIssue(db, issue.id, {
      action: "accept",
      comment: "接受当前交付，不要求真实 smoke。",
      review_request_id: request.id,
      review_revision: request.revision
    });
    const card = await buildIssueCompletionCard(db, issue.id);

    const updated = await applyPiAcceptanceDecision(
      { database: db, providers: { codex: provider } },
      card,
      decision("retry", "真实 smoke 未执行，应启动新 Session。")
    );

    expect(updated.status).toBe("done");
    expect(provider.inputs).toHaveLength(0);
    expect(listIssueRuns(db, issue.id)).toHaveLength(1);
    expect(db.sqlite.query<{ count: number }, [number]>(
      "select count(*) as count from issue_events where issue_id=? and type='issue.pi_human_acceptance_honored.v1'"
    ).get(issue.id)?.count).toBe(1);
  });

  test("accepted delivery review blocks PI continuation in the existing Provider Session", async () => {
    const db = await fixture();
    const provider = new ContinuingProvider();
    const issue = completedIssue(db, "Accepted delivery", "session-original", "turn-original");
    const originCard = await buildIssueCompletionCard(db, issue.id);
    recordIssueCompletionCard(db, originCard, "test");
    updateIssue(db, issue.id, { status: "needs_user" });
    const request = createHumanReviewRequest(db, issue.id, {
      consequences: "真实 smoke 未执行",
      evidence_refs: [`completion-card:${originCard.fingerprint}`],
      kind: "acceptance",
      question: "是否接受当前离线实现？"
    });
    await reviewHumanIssue(db, issue.id, {
      action: "accept",
      comment: "同意，我来测试。",
      review_request_id: request.id,
      review_revision: request.revision
    });
    const card = await buildIssueCompletionCard(db, issue.id);

    const updated = await applyPiAcceptanceDecision(
      { database: db, providers: { codex: provider } },
      card,
      decision("continue_same_session", "仍需补充正式提交和真实 Provider 验证。")
    );

    expect(updated.status).toBe("done");
    expect(provider.inputs).toHaveLength(0);
    expect(listIssueRuns(db, issue.id)).toHaveLength(1);
    expect(db.sqlite.query<{ count: number }, [number]>(
      "select count(*) as count from issue_events where issue_id=? and type='issue.pi_human_acceptance_honored.v1'"
    ).get(issue.id)?.count).toBe(1);
  });

  test("continues in the same Provider Session and creates a new canonical Run", async () => {
    const db = await fixture();
    const provider = new ContinuingProvider("claude");
    const issue = completedIssue(db, "Continue delivery", "session-original", "turn-original", "claude");
    selectProviderDefaultProfile(db, issue.id, "claude");
    const card = await buildIssueCompletionCard(db, issue.id);
    const updated = await applyPiAcceptanceDecision(
      { database: db, providers: { claude: provider } },
      card,
      decision("continue_same_session", "补充 Node 22 下的完整回归并报告退出码。")
    );

    expect(provider.inputs).toHaveLength(1);
    expect(provider.inputs[0]?.model).toBe("");
    expect(provider.inputs[0]).toMatchObject({
      issueId: issue.id,
      session: { provider: "claude", sessionId: "session-original", turnId: "turn-original" }
    });
    expect(provider.inputs[0]?.prompt).toContain("补充 Node 22 下的完整回归并报告退出码");
    expect(provider.inputs[0]?.prompt).toContain("不要因为任务是对话或没有仓库改动而使用 needs_user");
    expect(updated.status).toBe("in_progress");
    expect(listIssueRuns(db, issue.id)).toMatchObject([
      { attempt: 1, provider_session_id: "session-original", provider_turn_id: "turn-original" },
      { attempt: 2, provider_session_id: "session-original", provider_turn_id: "turn-next", status: "succeeded" }
    ]);
    expect(db.sqlite.query<{ count: number }, []>("select count(*) as count from issues").get()?.count).toBe(1);
  });

  for (const action of ["continue_same_session", "retry"] as const) {
    test(`${action} retains the original feature goal when PI wrongly requests a planning-only rollback`, async () => {
      const db = await fixture();
      const provider = action === "retry" ? new FreshSessionProvider() : new ContinuingProvider();
      const issue = completedIssue(db, "安全释放等待任务工作目录");
      const goal = "满足安全条件时释放目录；恢复时复核工作区。\n本批次只建 Issue，不启动。\n不自动 stash/reset/commit。";
      db.sqlite.run("update issues set description=? where id=?", [goal, issue.id]);
      const card = await buildIssueCompletionCard(db, issue.id);
      await applyPiAcceptanceDecision({ database: db, providers: { codex: provider } }, card,
        decision(action, "撤销本 Run 的全部实现，恢复为仅创建待办 Issue。"));
      const prompt = provider.inputs[0]?.prompt ?? "";
      expect(prompt).toContain(goal);
      expect(prompt).toContain("pre-dispatch planning state and is not a reason to undo this active Run");
      expect(prompt).toContain("PI follow-up instructions do not replace the original Issue goal");
      expect(prompt).toContain("A successful rollback or a clean workspace alone does not satisfy a feature implementation goal");
      expect(prompt).toContain("If substantive authorization is genuinely ambiguous, preserve the workspace and request a human decision");
      expect(getIssue(db, issue.id)?.status).toBe("in_progress");
      expect((await buildIssueCompletionCard(db, issue.id)).issue.goal).toBe(goal);
    });
  }
}
