import { expect, test } from "bun:test";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import type { TestFixture } from "./issuePatchApi.testFixture.ts";

export function registerFailsClosedForRunHistoryCases(testScope: TestFixture) {
  const { openFixtureDatabase, patchIssue, insertProject, insertIssue, insertOpenRun } = testScope;
  test("fails closed for Run history, cycles and inconsistent body declarations without partial writes", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "demo");
      const first = createIssue(database, { project_id: "demo", status: "triage", title: "first" });
      const second = createIssue(database, {
        depends_on_issue_ids: [first.id], project_id: "demo", status: "triage", title: "second"
      });
      const ran = createIssue(database, { project_id: "demo", status: "todo", title: "ran" });
      insertOpenRun(database, ran.id);
  
      const cycle = await patchIssue(database, first.id, {
        depends_on_issue_ids: [second.id], title: "must not persist"
      });
      const mismatch = await patchIssue(database, second.id, { description: "## Dependencies\n\nNone" });
      const runHistory = await patchIssue(database, ran.id, { title: "must not persist" });
  
      expect(cycle.status).toBe(400);
      expect(await cycle.json()).toEqual({
        message: `depends_on_issue_ids 会形成依赖环：Issue #${first.id} -> Issue #${second.id}`
      });
      expect(mismatch.status).toBe(400);
      expect(await mismatch.json()).toEqual({
        message: "正文依赖章节必须与 depends_on_issue_ids 完全一致；请同时更新正文和结构化依赖"
      });
      expect(runHistory.status).toBe(400);
      expect(await runHistory.json()).toEqual({
        message: "Issue 已存在 Run 历史，禁止更新 title、description 或 depends_on_issue_ids"
      });
      expect(database.sqlite.query<{ title: string }, [number]>("select title from issues where id=?").get(first.id))
        .toEqual({ title: "first" });
      expect(database.sqlite.query<{ title: string }, [number]>("select title from issues where id=?").get(ran.id))
        .toEqual({ title: "ran" });
    });
  
  test("returns stable errors for invalid and missing issue patches", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "demo");
      const issueId = insertIssue(database, "demo");
      const invalidStatus = await patchIssue(database, issueId, { status: "bogus" });
      const missing = await patchIssue(database, 404, { title: "Missing" });
  
      expect(invalidStatus.status).toBe(400);
      expect(await invalidStatus.json()).toEqual({ message: "status 不合法" });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ message: "资源不存在" });
    });
}
