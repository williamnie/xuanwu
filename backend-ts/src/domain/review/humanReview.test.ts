import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { listIssueEvents } from "../../db/repositories/issueEvents.ts";
import { createIssueRun, updateIssueRuntime } from "../../db/repositories/issueRuns.ts";
import { getIssue, listIssueRuns } from "../../db/repositories/issues.ts";
import type {
  ExecutorProvider,
  ProviderRunInput,
  SessionMessageInput
} from "../../providers/types.ts";
import { EventBus } from "../../events/bus.ts";
import {
  createHumanReviewRequest,
  readIssueVerificationProjection,
  reviewHumanIssue
} from "./humanReview.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("human review workflow", () => {
  test("keeps pending verification PI-owned until an explicit natural-language request exists", async () => {
    const db = await fixture();
    try {
      const issue = createIssue(db, {
        project_id: "demo",
        status: "pending_verification",
        title: "Architecture decision"
      });
      expect(readIssueVerificationProjection(db, issue.id)).toMatchObject({
        owner: "pi",
        phase: "pi_verifying",
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

      expect(readIssueVerificationProjection(db, issue.id)).toMatchObject({
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
      expect(accepted.status).toBe("pending_verification");
      expect(readIssueVerificationProjection(db, issue.id)).toMatchObject({
        owner: "pi",
        phase: "pi_verifying",
        request: { status: "accepted" }
      });
    } finally {
      db.close();
    }
  });

  test("requires request identity and resumes the same Session in a new Run/Turn with exact feedback", async () => {
    const db = await fixture();
    const provider = new RevisionProvider();
    try {
      const issue = createIssue(db, {
        project_id: "demo",
        status: "pending_verification",
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
        "update issue_runs set status='pending_verification', ended_at=? where id=?",
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
      expect(readIssueVerificationProjection(db, issue.id)).toMatchObject({
        owner: "pi",
        phase: "pi_repairing",
        request: { status: "changes_requested" }
      });
      expect(listIssueEvents(db, issue.id, {
        types: ["issue.human_revision_requested.v1"]
      })).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("keeps exact feedback and reopens the request when same-Session resume fails", async () => {
    const db = await fixture();
    try {
      const issue = createIssue(db, {
        project_id: "demo",
        status: "pending_verification",
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
        "update issue_runs set status='pending_verification', ended_at=? where id=?",
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

      expect(getIssue(db, issue.id)).toMatchObject({
        error: "resume unavailable",
        status: "pending_verification"
      });
      expect(readIssueVerificationProjection(db, issue.id)).toMatchObject({
        owner: "human",
        phase: "human_review",
        request: { id: request.id, status: "open" }
      });
      expect(listIssueRuns(db, issue.id).at(-1)).toMatchObject({
        error: "resume unavailable",
        exit_reason: "human_revision_resume_failed",
        status: "failed"
      });
      expect(listIssueEvents(db, issue.id, {
        types: ["issue.comment"]
      }).at(-1)?.payload).toContain("保留原 Session 并补充失败恢复");
    } finally {
      db.close();
    }
  });
});

class RevisionProvider implements ExecutorProvider {
  readonly capabilities = ["issue_execution", "resume_session"] as const;
  readonly id = "codex" as const;
  readonly messages: SessionMessageInput[] = [];

  async run(_input: ProviderRunInput) {
    return { runId: "unused" };
  }

  async sendSessionMessage(input: SessionMessageInput) {
    this.messages.push(input);
    return {
      provider: this.id,
      provider_session_id: input.sessionId,
      sessionId: input.sessionId,
      turn_id: "turn-revision"
    };
  }
}

class FailingRevisionProvider extends RevisionProvider {
  override async sendSessionMessage(_input: SessionMessageInput): Promise<never> {
    throw new Error("resume unavailable");
  }
}

async function fixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "human-review-"));
  roots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, auto_run, sort_order, created_at, updated_at)
     values ('demo', 'demo', ?, 'codex', 0, 1, ?, ?)`,
    [root, "2026-07-31T00:00:00Z", "2026-07-31T00:00:00Z"]
  );
  return db;
}
