import { expect, test } from "bun:test";

import { createIssue } from "../../db/repositories/issueCreate.ts";
import { listIssueEvents } from "../../db/repositories/issueEvents.ts";
import { createIssueRun, updateIssueRuntime } from "../../db/repositories/issueRuns.ts";
import { getIssue, listIssueRuns } from "../../db/repositories/issues.ts";
import { updateIssue } from "../../db/repositories/issueUpdate.ts";

import { EventBus } from "../../events/bus.ts";
import {
  createHumanReviewRequest,
  readIssueDecisionProjection,
  reopenIncorrectlyAcceptedHumanReview,
  reviewHumanIssue
} from "./humanReview.ts";

import { RevisionProvider, fixture } from "./humanReviewTestFixtures.ts";

export function registerHumanReviewOwnershipCases() {
  test("reopens an incorrectly accepted delivery review as an immutable corrected risk revision", async () => {
    const db = await fixture();
    const issue = createIssue(db, { project_id: "demo", status: "needs_user", title: "Paid provider acceptance" });
    const run = createIssueRun(db, issue.id);
    db.sqlite.run("update issue_runs set status='succeeded', ended_at=? where id=?", [
      "2026-08-13T00:00:00Z", run.id
    ]);
    const mistaken = createHumanReviewRequest(db, issue.id, {
      kind: "acceptance",
      question: "请授权真实付费测试"
    });
    await reviewHumanIssue(db, issue.id, {
      action: "accept",
      comment: "已授权，MAX_PAID_TURNS=10，MAX_CREDITS=3",
      review_request_id: mistaken.id,
      review_revision: mistaken.revision
    });
    updateIssue(db, issue.id, { status: "done" });

    const corrected = reopenIncorrectlyAcceptedHumanReview(db, issue.id, {
      kind: "risk_acceptance",
      question: mistaken.question,
      recovery_reason: "authorization was mistaken for delivery acceptance",
      reopen_accepted_request_id: mistaken.id,
      reopen_accepted_revision: mistaken.revision
    });

    expect(getIssue(db, issue.id)?.status).toBe("needs_user");
    expect(corrected).toMatchObject({ kind: "risk_acceptance", revision: 2, status: "open" });
    expect(readIssueDecisionProjection(db, issue.id)).toMatchObject({
      owner: "human",
      phase: "human_review",
      request: { id: corrected.id, kind: "risk_acceptance", status: "open" }
    });
    expect(listIssueEvents(db, issue.id, {
      types: ["issue.human_review_incorrect_acceptance_reopened.v1"]
    })).toHaveLength(1);
  });

  test("keeps needs_user PI-owned until an explicit natural-language request exists", async () => {
    const db = await fixture();
    const issue = createIssue(db, {
      project_id: "demo",
      status: "needs_user",
      title: "Architecture decision"
    });
    const run = createIssueRun(db, issue.id);
    db.sqlite.run(
      "update issue_runs set status='succeeded', ended_at=? where id=?",
      ["2026-07-31T00:00:00Z", run.id]
    );
    expect(readIssueDecisionProjection(db, issue.id)).toMatchObject({
      owner: "pi",
      phase: "pi_queued",
      request: null
    });

    const bus = new EventBus();
    const notifications: Array<{ payload?: string; text?: string; type: string }> = [];
    bus.observe((event) => notifications.push(event));
    const request = createHumanReviewRequest(db, issue.id, {
      acceptance_summary: ["Node/TypeScript/PostgreSQL", "OIDC", "BlobStore"],
      excluded_scope: ["安装数据库", "启动完整程序"],
      kind: "decision",
      question: "是否接受 Node/TypeScript/PostgreSQL、OIDC、BlobStore、Provider 适配层、禁止 Mock，以及 V0.1 范围这些技术和产品取舍？",
      recommendation: "接受"
    }, { bus });

    expect(readIssueDecisionProjection(db, issue.id)).toMatchObject({
      owner: "human",
      phase: "human_review",
      request: {
        id: request.id,
        question: request.question,
        status: "open"
      }
    });
    expect(notifications).toContainEqual(expect.objectContaining({
      text: expect.stringContaining(`你正在审批：${request.question}`),
      type: "pi.needs_user"
    }));
    expect(JSON.parse(notifications.at(-1)?.payload ?? "{}")).toMatchObject({
      acceptance_summary: ["Node/TypeScript/PostgreSQL", "OIDC", "BlobStore"],
      excluded_scope: ["安装数据库", "启动完整程序"],
      requires_user: true,
      review_request_id: request.id,
      user_facing_message: expect.stringContaining(request.question)
    });

    const accepted = await reviewHumanIssue(db, issue.id, {
      action: "accept",
      review_request_id: request.id,
      review_revision: request.revision
    });
    expect(accepted.status).toBe("in_progress");
    expect(readIssueDecisionProjection(db, issue.id)).toMatchObject({
      owner: "pi",
      phase: "pi_queued",
      request: { status: "accepted" }
    });
  });

  test("requires request identity and resumes the same Session in a new Run/Turn with exact feedback", async () => {
    const db = await fixture();
    const provider = new RevisionProvider();
    const issue = createIssue(db, {
      project_id: "demo",
      status: "needs_user",
      title: "Architecture decision"
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
      question: "是否接受当前 V0.1 技术和产品取舍？"
    });

    await expect(reviewHumanIssue(db, issue.id, {
      action: "request_changes",
      comment: "OIDC 改为可插拔，并补充迁移边界",
      review_request_id: "stale",
      review_revision: request.revision
    }, { providers: { codex: provider } })).rejects.toThrow("已更新");

    const revision = reviewHumanIssue(db, issue.id, {
      action: "request_changes",
      comment: "OIDC 改为可插拔，并补充迁移边界",
      review_request_id: request.id,
      review_revision: request.revision
    }, { providers: { codex: provider } });
    await expect(reviewHumanIssue(db, issue.id, {
      action: "request_changes",
      comment: "重复提交不应创建第二个 Run",
      review_request_id: request.id,
      review_revision: request.revision
    }, { providers: { codex: provider } })).rejects.toThrow("当前没有等待人类处理的验收请求");
    const result = await revision;

    expect(result.status).toBe("in_progress");
    expect(provider.messages).toHaveLength(1);
    expect(provider.messages[0]).toMatchObject({ sessionId: "session-original" });
    expect(provider.messages[0]?.prompt).toContain("OIDC 改为可插拔，并补充迁移边界");
    const runs = listIssueRuns(db, issue.id);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({
      attempt: 2,
      provider_session_id: "session-original",
      provider_turn_id: "turn-revision"
    });
    expect(readIssueDecisionProjection(db, issue.id)).toMatchObject({
      owner: "pi",
      phase: "pi_continuing",
      request: { status: "changes_requested" }
    });
    expect(listIssueEvents(db, issue.id, {
      types: ["issue.human_revision_requested.v1"]
    })).toHaveLength(1);
  });
}
