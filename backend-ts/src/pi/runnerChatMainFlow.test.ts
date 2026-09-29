import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { createIssueRun } from "../db/repositories/issueRuns.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { getProject } from "../db/repositories/projects.ts";
import { upsertAgentSession } from "../db/repositories/agentSessions.ts";
import { listPiActions } from "../db/repositories/pi.ts";
import { createHumanReviewRequest, readIssueDecisionProjection, reviewHumanIssue } from "../domain/review/humanReview.ts";
import { readIssueDependency } from "../domain/work/issueDependency.ts";
import { PI_RUNNER_CHAT_ACTIONS } from "../http/piRuntime.ts";
import { requestIssuePiAcceptance } from "../runner/piAcceptanceRequest.ts";
import { runPiAcceptanceCoordinatorOnce } from "../runner/piAcceptanceCoordinator.ts";
import { createPiRunnerActions } from "./runnerActions.ts";
import { createIssueExecutionStatus } from "./issueToolViews.ts";
import { PI_READ_ONLY_ACTION_TYPES } from "./actionGate.ts";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

describe("Runner Chat main flow", () => {
  for (const source of ["runner_chat", "feishu_runner_chat", "telegram_runner_chat", "matrix_runner_chat"]) {
    for (const bound of [false, true]) {
      test(`${source}, ${bound ? "other project" : "global"}: human acceptance closes only the target and unlocks dependencies`, async () => {
        const db = await fixture();
        try {
          const issue = endedIssue(db);
          const dependent = createIssue(db, { project_id: "target", title: "Dependent", status: "triage",
            description: `## 依赖\n- Issue #${issue.id}`, depends_on_issue_ids: [issue.id] });
          const actions = chatActions(db, source, bound);
          const review = actions.createHumanReviewRequest({ issue_id: issue.id, kind: "acceptance",
            question: "接受已经人工核对的当前交付，不再追加验证", evidence_refs: [`run:${issue.run.id}`] }) as { id: string; revision: number };
          expect(review.id).toStartWith(`human-review-${issue.id}-`);
          expect(await actions.respondToHumanReview({ issue_id: issue.id, action: "accept",
            review_request_id: review.id, review_revision: review.revision, comment: "已核对，完成后继续后续任务" }))
            .toMatchObject({ status: "completed", decision: "execute" });
          expect(getIssue(db, issue.id)?.status).toBe("in_progress");
          expect(readIssueDependency(db, dependent.id)?.ready).toBe(false);
          // PI 重复提出同一缺口时，已确认的交付必须优先，不能重启执行器。
          expect(await runPiAcceptanceCoordinatorOnce({ database: db, decideIssueAcceptance: async () => decision("needs_user") }))
            .toMatchObject({ failed: 0, started: 1 });
          expect(getIssue(db, issue.id)?.status).toBe("done");
          expect(listIssueRuns(db, issue.id)).toHaveLength(1);
          expect(getIssue(db, dependent.id)?.status).toBe("triage");
          expect(readIssueDependency(db, dependent.id)?.ready).toBe(true);
          expect(listPiActions(db).every(action => action.status === "completed")).toBe(true);
        } finally { db.close(); }
      });
    }
  }

  test("global chat reads Session, recommends and assigns an executor, and comments on an exact Issue", async () => {
    const db = await fixture();
    try {
      const issue = createIssue(db, { project_id: "target", title: "Unstarted", status: "triage" });
      upsertAgentSession(db, { provider: "codex", provider_session_id: "session-target", project_id: "target", issue_id: issue.id });
      const actions = chatActions(db, "telegram_runner_chat", false);
      expect(actions.readSessionSummary({ session_key: "codex:session-target" })).toMatchObject({ issue_id: issue.id });
      expect(actions.listSessions({ project_id: "target" })).toMatchObject({ items: [expect.objectContaining({ issue_id: issue.id })] });
      expect(actions.recommendExecutorProfile({ issue_id: issue.id })).toMatchObject({ issue_id: issue.id });
      expect(actions.assignExecutorProfileProposal({ issue_id: issue.id, agent_profile_id: "xuanwu-provider-codex" }))
        .toMatchObject({ status: "completed", decision: "execute" });
      expect(getIssue(db, issue.id)?.agent_profile_id).toBe("xuanwu-provider-codex");
      expect(actions.commentIssue({ issue_id: issue.id, body: "确认采用这个执行器" })).toMatchObject({ type: "issue.comment" });
    } finally { db.close(); }
  });

  test("an ended needs_user Issue without a review can request PI acceptance without a new Run", async () => {
    const db = await fixture();
    try {
      const issue = endedIssue(db);
      expect(await chatActions(db, "runner_chat", false).requestIssueAcceptanceAction({ issue_id: issue.id, rationale: "检查当前结果" }))
        .toMatchObject({ status: "completed", decision: "execute" });
      expect(getIssue(db, issue.id)?.status).toBe("in_progress");
      expect(listIssueRuns(db, issue.id)).toHaveLength(1);
      expect(await runPiAcceptanceCoordinatorOnce({ database: db, decideIssueAcceptance: async () => decision("accept") }))
        .toMatchObject({ started: 1, failed: 0 });
      expect(getIssue(db, issue.id)?.status).toBe("done");
    } finally { db.close(); }
  });

  test("acceptance cannot bypass an open human decision or mutate an Issue without a Run", async () => {
    const db = await fixture();
    try {
      const issue = endedIssue(db);
      createHumanReviewRequest(db, issue.id, { question: "允许真实付费测试吗？", kind: "risk_acceptance" });
      expect(() => requestIssuePiAcceptance(db, issue.id, { source: "test" })).toThrow(/human_review_response/);
      expect(getIssue(db, issue.id)?.status).toBe("needs_user");
      expect(createIssueExecutionStatus(db, issue.id).completion).toMatchObject({ state: "human_review", next_step: expect.stringContaining("human_review_response") });

      const noRun = createIssue(db, { project_id: "target", title: "No Run", status: "needs_user" });
      const review = createHumanReviewRequest(db, noRun.id, { question: "确认方案" });
      const before = listIssueEvents(db, noRun.id).length;
      await expect(reviewHumanIssue(db, noRun.id, { action: "accept", comment: "确认", review_request_id: review.id, review_revision: review.revision }))
        .rejects.toThrow(/canonical Run/);
      expect(getIssue(db, noRun.id)?.status).toBe("needs_user");
      expect(readIssueDecisionProjection(db, noRun.id).request?.status).toBe("open");
      expect(listIssueEvents(db, noRun.id)).toHaveLength(before);
    } finally { db.close(); }
  });

  test("a human reply in the same timestamp second schedules a fresh decision on the same Run", async () => {
    const db = await fixture();
    try {
      const issue = endedIssue(db, "in_progress");
      requestIssuePiAcceptance(db, issue.id, { source: "test" });
      let previousRevision = "";
      await runPiAcceptanceCoordinatorOnce({ database: db, decideIssueAcceptance: async card => {
        previousRevision = card.issue.updated_at;
        return decision("needs_user");
      } });
      const review = readIssueDecisionProjection(db, issue.id).request!;
      await reviewHumanIssue(db, issue.id, { action: "accept", review_request_id: review.id, review_revision: review.revision });
      // issues.updated_at 当前精度是秒；同秒往返到 in_progress 不能吞掉新的人工回答。
      db.sqlite.run("update issues set updated_at=? where id=?", [previousRevision, issue.id]);
      expect(await runPiAcceptanceCoordinatorOnce({ database: db, decideIssueAcceptance: async () => decision("accept") }))
        .toMatchObject({ failed: 0, started: 1 });
      expect(getIssue(db, issue.id)?.status).toBe("done");
      expect(listIssueRuns(db, issue.id)).toHaveLength(1);
    } finally { db.close(); }
  });

  test("completion requests preserve an active Run and cancelled Issues never suggest acceptance", async () => {
    const db = await fixture();
    try {
      const active = createIssue(db, { project_id: "target", title: "Still running", status: "in_progress" });
      const run = createIssueRun(db, active.id);
      requestIssuePiAcceptance(db, active.id, { source: "test" });
      expect(getIssue(db, active.id)?.status).toBe("in_progress");
      expect(listIssueRuns(db, active.id)[0]).toMatchObject({ id: run.id, ended_at: "" });
      expect(await runPiAcceptanceCoordinatorOnce({ database: db, decideIssueAcceptance: async () => { throw new Error("Run is still active"); } }))
        .toMatchObject({ started: 0 });
      const cancelled = endedIssue(db, "cancelled");
      expect(createIssueExecutionStatus(db, cancelled.id).completion).toMatchObject({ state: "cancelled", retry_recommended: false });
      expect(() => requestIssuePiAcceptance(db, cancelled.id, { source: "test" })).toThrow(/cancelled/);
      expect(getIssue(db, cancelled.id)?.status).toBe("cancelled");
    } finally { db.close(); }
  });
});

function chatActions(db: RunnerDatabase, source: string, bound: boolean) {
  return createPiRunnerActions(db, { source, project: bound ? getProject(db, "conversation")! : undefined,
    authorization: { mode: "delegated", allowedActions: [...PI_RUNNER_CHAT_ACTIONS],
      ...(bound ? {} : { askOnMissingAuthorization: true }),
      authorizedActions: (bound ? PI_RUNNER_CHAT_ACTIONS : PI_READ_ONLY_ACTION_TYPES).map(action_type => ({ action_type })),
      scopes: [{ runner_resource: "skills" }, { runner_resource: "agent_catalog" }, { runner_resource: "issues" },
        ...(bound ? [{ project_id: "conversation" }] : [])] } });
}

function endedIssue(db: RunnerDatabase, status = "needs_user") {
  const issue = createIssue(db, { project_id: "target", title: "Already implemented", status });
  const run = createIssueRun(db, issue.id);
  db.sqlite.run("update issue_runs set status='needs_user', ended_at=? where id=?", [new Date().toISOString(), run.id]);
  return { ...issue, run };
}

function decision(value: "accept" | "needs_user") {
  return { valid: true as const, raw_text: "{}", decision: { confidence: "high" as const, decision: value,
    evidence_refs: [], progress: { made_progress: true, evidence_refs: [], summary: "实现已完成" },
    human_review_kind: "acceptance" as const, rationale: "确认当前交付", unmet_requirements: [] } };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-chat-main-flow-"));
  roots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  for (const id of ["target", "conversation"]) {
    await mkdir(join(root, id));
    db.sqlite.run("insert into projects (id,name,cwd,provider,created_at,updated_at) values (?,?,?,'codex',?,?)",
      [id, id, join(root, id), "2026-09-28T00:00:00Z", "2026-09-28T00:00:00Z"]);
    db.sqlite.run("insert into project_pi_settings (project_id,created_at,updated_at) values (?,?,?)",
      [id, "2026-09-28T00:00:00Z", "2026-09-28T00:00:00Z"]);
  }
  return db;
}
