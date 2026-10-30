import { expect, test } from "bun:test";
import { getIssue, listIssueRuns } from "../../db/repositories/issues.ts";
import { createIssueRun } from "../../db/repositories/issueRuns.ts";
import { createPiAction, getPiIssueCompletionWatch } from "../../db/repositories/pi.ts";
import { createHumanReviewRequest, readIssueDecisionProjection } from "../../domain/review/humanReview.ts";
import { dispatchPiAction } from "./piActionDispatch.ts";
import { isProjectLoopActive } from "../../runner/projectLoopManager.ts";
import type { TestFixture } from "./piActionDispatch.testFixture.ts";

export function registerIssueEnqueueStartsOnlyAutoCases(testScope: TestFixture) {
  const { fixtureDb, NO_AUTO_RUN_SETTLE_MS, insertProject, insertIssue, SupervisorProvider, waitUntil } = testScope;
  test("issue.enqueue starts only auto-run project loop after approval dispatch", async () => {
      const db = await fixtureDb();
      const provider = new SupervisorProvider();
      insertProject(db, "manual-demo", { autoRun: 0, provider: provider.id });
      insertProject(db, "auto-demo", { autoRun: 1, provider: provider.id });
      insertIssue(db, { issueID: 411, projectID: "manual-demo", status: "triage" });
      insertIssue(db, { issueID: 410, projectID: "auto-demo", status: "triage" });
      const manualAction = createPiAction(db, {
        action_type: "issue.enqueue",
        id: "enqueue-manual-action",
        issue_id: 411,
        payload_json: JSON.stringify({ issue_id: 411 }),
        project_id: "manual-demo",
        status: "approved"
      });
      const autoAction = createPiAction(db, {
        action_type: "issue.enqueue",
        id: "enqueue-auto-action",
        issue_id: 410,
        payload_json: JSON.stringify({ issue_id: 410 }),
        project_id: "auto-demo",
        status: "approved"
      });
  
      await dispatchPiAction({ database: db, providers: { codex: provider } }, manualAction);
      await Bun.sleep(NO_AUTO_RUN_SETTLE_MS);
  
      expect(provider.inputs).toEqual([]);
      expect(getIssue(db, 411)).toMatchObject({ status: "todo" });
      await dispatchPiAction({ database: db, providers: { codex: provider } }, autoAction);
  
      await waitUntil(() => provider.inputs.length > 0);
      expect(provider.inputs[0]).toMatchObject({ issueId: 410, projectId: "auto-demo" });
      expect(getIssue(db, 410)).toMatchObject({ status: "in_progress" });
      await waitUntil(() => !isProjectLoopActive("auto-demo"));
    });
  
  test("issue.enqueue can force kick the project loop for Runner Chat dispatch", async () => {
      const db = await fixtureDb();
      const provider = new SupervisorProvider();
      const kickedProjects: string[] = [];
      insertProject(db, "manual-demo", { autoRun: 0, provider: provider.id });
      insertIssue(db, { issueID: 386, projectID: "manual-demo", status: "triage" });
      const action = createPiAction(db, {
        action_type: "issue.enqueue",
        id: "enqueue-runner-chat-action",
        issue_id: 386,
        payload_json: JSON.stringify({ issue_id: 386 }),
        project_id: "manual-demo",
        source: "runner_chat",
        status: "approved"
      });
  
      await dispatchPiAction({
        database: db,
        providers: { codex: provider },
        startProjectLoop: (_runtime, projectID) => kickedProjects.push(projectID)
      }, action);
  
      expect(getIssue(db, 386)).toMatchObject({ status: "todo" });
      expect(kickedProjects).toEqual(["manual-demo"]);
      expect(provider.inputs).toEqual([]);
    });
  
  test("issue.cancel dispatch cancels every explicit issue in one project", async () => {
      const db = await fixtureDb();
      insertProject(db, "demo");
      insertIssue(db, { issueID: 812, projectID: "demo", status: "triage" });
      insertIssue(db, { issueID: 813, projectID: "demo", status: "triage" });
      insertIssue(db, { issueID: 814, projectID: "demo", status: "triage" });
      const action = createPiAction(db, {
        action_type: "issue.cancel",
        id: "cancel-explicit-batch",
        payload_json: JSON.stringify({ issue_ids: [812, 813, 814] }),
        project_id: "demo",
        status: "approved"
      });
  
      const result = await dispatchPiAction({ database: db }, action);
  
      expect(result).toMatchObject({
        accepted: 3,
        project_id: "demo",
        requested_status: "cancelled",
        status: "completed"
      });
      expect([812, 813, 814].map((id) => getIssue(db, id)?.status)).toEqual([
        "cancelled", "cancelled", "cancelled"
      ]);
    });
  
  test("issue.status_update dispatch applies a canonical batch transition", async () => {
      const db = await fixtureDb();
      insertProject(db, "demo");
      insertIssue(db, { issueID: 815, projectID: "demo", status: "triage" });
      insertIssue(db, { issueID: 816, projectID: "demo", status: "triage" });
      const action = createPiAction(db, {
        action_type: "issue.status_update",
        id: "status-update-explicit-batch",
        payload_json: JSON.stringify({
          issue_ids: [815, 816],
          reason: "用户要求放入待办",
          status: "todo"
        }),
        project_id: "demo",
        status: "approved"
      });
  
      const result = await dispatchPiAction({ database: db }, action);
  
      expect(result).toMatchObject({
        accepted: 2,
        project_id: "demo",
        requested_status: "todo",
        status: "completed"
      });
      expect([815, 816].map((id) => getIssue(db, id)?.status)).toEqual(["todo", "todo"]);
    });
  
  test("human_review.respond dispatch accepts the completed Run without creating a retry Run", async () => {
      const db = await fixtureDb();
      insertProject(db, "demo");
      insertIssue(db, { issueID: 827, projectID: "demo", status: "needs_user" });
      const run = createIssueRun(db, 827);
      db.sqlite.run(
        "update issue_runs set status='succeeded', ended_at=? where id=?",
        ["2026-08-01T00:00:00Z", run.id]
      );
      const request = createHumanReviewRequest(db, 827, {
        question: "是否接受离线实现，并由用户后续手动执行真实 smoke？"
      });
      const action = createPiAction(db, {
        action_type: "human_review.respond",
        id: "human-review-response-827",
        issue_id: 827,
        payload_json: JSON.stringify({
          action: "accept",
          comment: "接受当前实现；真实 smoke 后续手动执行。",
          issue_id: 827,
          review_request_id: request.id,
          review_revision: request.revision
        }),
        project_id: "demo",
        status: "approved"
      });
  
      await dispatchPiAction({ database: db }, action);
  
      expect(getIssue(db, 827)?.status).toBe("in_progress");
      expect(listIssueRuns(db, 827)).toHaveLength(1);
      expect(readIssueDecisionProjection(db, 827)).toMatchObject({
        owner: "pi",
        phase: "pi_queued",
        request: { id: request.id, status: "accepted" }
      });
    });
  
  test("issue completion watch create/cancel dispatch persists watch rows after approval", async () => {
      const db = await fixtureDb();
      insertProject(db, "demo");
      insertIssue(db, { issueID: 547, projectID: "demo", status: "todo" });
      const createAction = createPiAction(db, {
        action_type: "issue_completion_watch.create",
        id: "watch-create-action",
        payload_json: JSON.stringify({
          issue_ids: [547],
          project_id: "demo",
          source_event_id: "event-547",
          target_channel: "feishu",
          target_chat_id: "oc_group"
        }),
        project_id: "demo",
        status: "approved"
      });
  
      const created = await dispatchPiAction({ database: db }, createAction) as { watch_id?: string };
      const watchID = created.watch_id ?? "";
  
      expect(created).toMatchObject({
        already_satisfied: false,
        target_channel: "feishu",
        watched_issues: [expect.objectContaining({ id: 547, status: "todo" })]
      });
      expect(getPiIssueCompletionWatch(db, watchID)).toMatchObject({
        status: "active",
        target_chat_id: "oc_group",
        items: [expect.objectContaining({ issue_id: 547 })]
      });
  
      const cancelAction = createPiAction(db, {
        action_type: "issue_completion_watch.cancel",
        id: "watch-cancel-action",
        payload_json: JSON.stringify({ reason: "user_cancel", watch_id: watchID }),
        project_id: "demo",
        status: "approved"
      });
      const cancelled = await dispatchPiAction({ database: db }, cancelAction);
  
      expect(cancelled).toMatchObject({
        current_status: "cancelled",
        watch_id: watchID
      });
      expect(getPiIssueCompletionWatch(db, watchID)).toMatchObject({
        error: "user_cancel",
        status: "cancelled"
      });
    });
}
