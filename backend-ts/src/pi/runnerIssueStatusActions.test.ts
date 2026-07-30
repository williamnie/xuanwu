import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { getIssue } from "../db/repositories/issues.ts";
import {
  allowedIssueStatusTargets,
  executeIssueStatusUpdate,
  prepareIssueStatusUpdate
} from "./runnerIssueStatusActions.ts";

describe("PI issue status actions", () => {
  test("exposes every canonical status edge and keeps terminal states closed", () => {
    expect(allowedIssueStatusTargets("triage")).toEqual(["todo", "cancelled"]);
    expect(allowedIssueStatusTargets("todo")).toEqual(["triage", "in_progress", "cancelled"]);
    expect(allowedIssueStatusTargets("in_progress")).toEqual(["todo", "pending_verification", "failed", "cancelled"]);
    expect(allowedIssueStatusTargets("pending_verification")).toEqual([
      "triage", "in_progress", "done", "failed", "cancelled"
    ]);
    expect(allowedIssueStatusTargets("failed")).toEqual(["triage", "todo", "pending_verification", "cancelled"]);
    expect(allowedIssueStatusTargets("done")).toEqual([]);
    expect(allowedIssueStatusTargets("cancelled")).toEqual([]);
  });

  test("moves issues through queue, verification, failure, and cancellation semantics", async () => {
    const fixture = await openFixture();
    const executionRequests: string[] = [];
    try {
      const queue = createIssue(fixture.db, { project_id: "demo", status: "triage", title: "Queue" });
      const verification = createIssue(fixture.db, {
        project_id: "demo",
        status: "pending_verification",
        title: "Verification"
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
        issue_ids: [verification.id],
        reason: "验收不通过",
        status: "failed"
      })).toMatchObject({ accepted: 1, items: [{ actual_status: "failed", reached_target: true }] });
      expect(await executeIssueStatusUpdate(fixture.db, {
        issue_ids: [verification.id], reason: "重新提交验收", status: "pending_verification"
      })).toMatchObject({ accepted: 1, items: [{ actual_status: "pending_verification", reached_target: true }] });
      expect(await executeIssueStatusUpdate(fixture.db, {
        issue_ids: [verification.id], reason: "需要继续修改", status: "triage"
      })).toMatchObject({ accepted: 1, items: [{ actual_status: "triage", reached_target: true }] });
      expect(await executeIssueStatusUpdate(fixture.db, {
        issue_ids: [cancel.id], reason: "不再处理", status: "cancelled"
      })).toMatchObject({ accepted: 1, items: [{ actual_status: "cancelled", reached_target: true }] });

      expect(executionRequests).toEqual(["demo"]);
      expect(getIssue(fixture.db, queue.id)?.status).toBe("todo");
      expect(getIssue(fixture.db, verification.id)?.status).toBe("triage");
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
});

async function openFixture(): Promise<{ close(): Promise<void>; db: RunnerDatabase }> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-issue-status-actions-"));
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
