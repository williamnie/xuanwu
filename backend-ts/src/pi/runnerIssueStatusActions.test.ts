import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { createIssueRun } from "../db/repositories/issueRuns.ts";
import {
  allowedIssueStatusTargets,
  executeIssueStatusUpdate,
  prepareIssueStatusUpdate
} from "./runnerIssueStatusActions.ts";

describe("PI issue status actions", () => {
  test("exposes every canonical status edge and keeps terminal states closed", () => {
    expect(allowedIssueStatusTargets("triage")).toEqual(["todo", "cancelled"]);
    expect(allowedIssueStatusTargets("todo")).toEqual(["triage", "in_progress", "cancelled"]);
    expect(allowedIssueStatusTargets("in_progress")).toEqual(["todo", "needs_user", "done", "failed", "cancelled"]);
    expect(allowedIssueStatusTargets("needs_user")).toEqual(["in_progress", "done", "failed", "cancelled"]);
    expect(allowedIssueStatusTargets("failed")).toEqual(["triage", "todo", "cancelled"]);
    expect(allowedIssueStatusTargets("done")).toEqual([]);
    expect(allowedIssueStatusTargets("cancelled")).toEqual([]);
  });

  test("moves issues through queue, PI failure, retry, and cancellation semantics", async () => {
    const fixture = await openFixture();
    const executionRequests: string[] = [];
    try {
      const queue = createIssue(fixture.db, { project_id: "demo", status: "triage", title: "Queue" });
      const decision = createIssue(fixture.db, {
        project_id: "demo",
        status: "in_progress",
        title: "PI decision"
      });
      const cancel = createIssue(fixture.db, { project_id: "demo", status: "triage", title: "Cancel" });

      expect(await executeIssueStatusUpdate(fixture.db, {
        issue_ids: [queue.id], reason: "放入待办", status: "todo"
      })).toMatchObject({ accepted: 1, items: [{ actual_status: "todo", reached_target: true }] });
      expect(await executeIssueStatusUpdate(fixture.db, {
        issue_ids: [queue.id], reason: "开始执行", status: "in_progress"
      }, {
        onExecutionRequested: (projectID) => executionRequests.push(projectID)
      })).toMatchObject({
        accepted: 1,
        items: [{ actual_status: "todo", execution_requested: true, reached_target: false }]
      });
      expect(await executeIssueStatusUpdate(fixture.db, {
        error: "缺少测试",
        issue_ids: [decision.id],
        reason: "验收不通过",
        status: "failed"
      })).toMatchObject({ accepted: 1, items: [{ actual_status: "failed", reached_target: true }] });
      expect(await executeIssueStatusUpdate(fixture.db, {
        issue_ids: [decision.id], reason: "PI 决定重试", status: "todo"
      })).toMatchObject({ accepted: 1, items: [{ actual_status: "todo", reached_target: true }] });
      expect(await executeIssueStatusUpdate(fixture.db, {
        issue_ids: [cancel.id], reason: "不再处理", status: "cancelled"
      })).toMatchObject({ accepted: 1, items: [{ actual_status: "cancelled", reached_target: true }] });

      expect(executionRequests).toEqual(["demo"]);
      expect(getIssue(fixture.db, queue.id)?.status).toBe("todo");
      expect(getIssue(fixture.db, decision.id)?.status).toBe("todo");
      expect(getIssue(fixture.db, cancel.id)?.status).toBe("cancelled");
    } finally {
      await fixture.close();
    }
  });

  test("prevalidates a batch and leaves every issue untouched on an invalid edge", async () => {
    const fixture = await openFixture();
    try {
      const done = createIssue(fixture.db, { project_id: "demo", status: "done", title: "Done" });
      const triage = createIssue(fixture.db, { project_id: "demo", status: "triage", title: "Triage" });

      expect(() => prepareIssueStatusUpdate(fixture.db, {
        issue_ids: [done.id, triage.id],
        reason: "invalid",
        status: "todo"
      })).toThrow(/不允许从 done 移动到 todo/);
      expect(getIssue(fixture.db, done.id)?.status).toBe("done");
      expect(getIssue(fixture.db, triage.id)?.status).toBe("triage");
    } finally {
      await fixture.close();
    }
  });

  test("does not turn a needs_user acceptance response into a retry Run", async () => {
    const fixture = await openFixture();
    try {
      const issue = createIssue(fixture.db, {
        project_id: "demo",
        status: "needs_user",
        title: "Completed implementation awaiting user acceptance"
      });
      const run = createIssueRun(fixture.db, issue.id);
      fixture.db.sqlite.run(
        "update issue_runs set status='succeeded', ended_at=? where id=?",
        ["2026-08-01T00:00:00Z", run.id]
      );

      expect(() => prepareIssueStatusUpdate(fixture.db, {
        issue_ids: [issue.id],
        reason: "用户接受当前实现，真实 smoke 后续手动执行",
        status: "in_progress"
      })).toThrow(/human_review_response/);

      expect(getIssue(fixture.db, issue.id)?.status).toBe("needs_user");
      expect(listIssueRuns(fixture.db, issue.id)).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });
});

async function openFixture(): Promise<{ close(): Promise<void>; db: RunnerDatabase }> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-bun-issue-status-actions-"));
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    ["demo", "Demo", join(root, "project"), 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  return {
    db,
    close: async () => {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}
