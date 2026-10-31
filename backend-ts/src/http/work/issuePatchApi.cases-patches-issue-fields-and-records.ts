import { expect, test } from "bun:test";
import { createAgentProfile } from "../../db/repositories/agentProfiles.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import type { TestFixture } from "./issuePatchApi.testFixture.ts";

export function registerPatchesIssueFieldsAndRecordsCases(testScope: TestFixture) {
  const { openFixtureDatabase, fullPatchPayload, expectedPatchedIssue, patchIssue, listEvents, insertProject, insertIssue, insertOpenRun, insertCommandEvidenceEvent, latestRun } = testScope;
  test("patches issue fields and records status change history", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "demo");
      createAgentProfile(database, { id: "codex-pro", name: "Codex Pro", provider: "codex" });
      const issueId = insertIssue(database, "demo");
      const response = await patchIssue(database, issueId, fullPatchPayload());
      const body = await response.json() as Record<string, unknown>;
  
      expect(response.status).toBe(200);
      expect(body).toMatchObject(expectedPatchedIssue(issueId));
      expect(listEvents(database)).toEqual([
        { type: "issue.status_changed", payload: "{\"status\":\"todo\"}" },
        {
          type: "issue.planning_metadata_updated.v1",
          payload: JSON.stringify({
            contract: "unstarted-issue-planning-update-v1",
            fields: ["title", "description"]
          })
        },
        {
          type: "issue.lifecycle_control.v1",
          payload: JSON.stringify({
            actor: { kind: "operator", source: "http", thread_id: "" },
            after_status: "todo",
            before_status: "triage",
            issue_run_id: "",
            operation: "status_update"
          })
        }
      ]);
    });
  
  test("rejects an unknown agent profile instead of silently falling back", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "demo");
      const issueId = insertIssue(database, "demo");
  
      const response = await patchIssue(database, issueId, { agent_profile_id: "missing-profile" });
  
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ message: "Agent Profile \"missing-profile\" was not found" });
    });
  
  test("defers a done claim until the active Provider Run reaches terminal state", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "demo");
      const issueId = insertIssue(database, "demo", "in_progress");
      insertOpenRun(database, issueId);
  
      const response = await patchIssue(database, issueId, { status: "done", error: "" });
      const run = latestRun(database, issueId);
  
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: issueId,
        status: "in_progress",
        error: ""
      });
      expect(run).toMatchObject({
        status: "in_progress"
      });
      expect(run?.ended_at).toBe("");
      expect(listEvents(database).map((event) => event.type)).toEqual([
        "issue.pi_acceptance_deferred.v1"
      ]);
    });
  
  test("routes an ended Run to PI acceptance without classifying command text", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "demo");
      const issueId = insertIssue(database, "demo", "in_progress");
      insertOpenRun(database, issueId);
      database.sqlite.run(
        "update issue_runs set status='failed', ended_at='2026-01-01T00:01:00Z' where issue_id=?",
        [issueId]
      );
      insertCommandEvidenceEvent(database, issueId, "/bin/zsh -lc 'custom-check --scope all; rc=$?; exit \"$rc\"'", 0);
  
      const response = await patchIssue(database, issueId, { status: "done", error: "" });
      const events = listEvents(database);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: issueId,
        status: "in_progress",
        error: ""
      });
      expect(events.map((event) => event.type)).toContain("issue.pi_acceptance_requested.v1");
      expect(events.some((event) => event.type.startsWith("issue.verification_gate_"))).toBe(false);
    });
  
  test("rejects raw in progress to todo patches so callers cannot orphan a running session", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "demo");
      const issueId = insertIssue(database, "demo", "in_progress");
      insertOpenRun(database, issueId);
  
      const response = await patchIssue(database, issueId, { status: "todo" });
  
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ message: "运行中的 Issue 请使用 retry 操作，避免重复创建 Session" });
      expect(latestRun(database, issueId)).toMatchObject({ status: "in_progress", ended_at: "" });
    });
  
  test("rejects a generic failed status patch because only PI may decide failure", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "demo");
      const issueId = insertIssue(database, "demo", "in_progress");
  
      const response = await patchIssue(database, issueId, { status: "failed", error: "agent fallback" });
  
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        message: "failed 只能由 PI 语义决策写入"
      });
      expect(database.sqlite.query<{ status: string }, [number]>("select status from issues where id=?").get(issueId))
        .toEqual({ status: "in_progress" });
    });
  
  test("moves a triage issue to an existing project", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "demo");
      insertProject(database, "target");
      const issueId = insertIssue(database, "demo");
  
      const response = await patchIssue(database, issueId, { project_id: "target" });
  
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: issueId, project_id: "target" });
    });
  
  test("rejects moving an issue after it leaves triage or to a missing project", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "demo");
      const triageIssueId = insertIssue(database, "demo");
      const queuedIssueId = insertIssue(database, "demo", "todo");
  
      const missingProject = await patchIssue(database, triageIssueId, { project_id: "missing" });
      const queuedIssue = await patchIssue(database, queuedIssueId, { project_id: "demo" });
  
      expect(missingProject.status).toBe(404);
      expect(await missingProject.json()).toEqual({ message: "资源不存在" });
      expect(queuedIssue.status).toBe(400);
      expect(await queuedIssue.json()).toEqual({ message: "只有 Triage 状态的 Issue 可以更换所属项目" });
    });
  
  test("rejects moving an issue while a structural dependency relation exists", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "demo");
      insertProject(database, "target");
      const upstream = createIssue(database, {
        project_id: "demo",
        status: "todo",
        title: "upstream"
      });
      const downstream = createIssue(database, {
        depends_on_issue_ids: [upstream.id],
        project_id: "demo",
        status: "triage",
        title: "downstream"
      });
  
      const response = await patchIssue(database, downstream.id, { project_id: "target" });
  
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        message: "存在结构化依赖关系的 Issue 不能更换所属项目"
      });
    });
  
  test("preserves title on a body-only patch and atomically replaces then clears dependencies", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "demo");
      const upstream = createIssue(database, { project_id: "demo", status: "todo", title: "upstream" });
      const issueId = insertIssue(database, "demo");
      const description = `Updated body\n\n## Dependencies\n\n- Issue #${upstream.id}`;
  
      const updated = await patchIssue(database, issueId, {
        depends_on_issue_ids: [upstream.id],
        description
      });
      const replay = await patchIssue(database, issueId, {
        depends_on_issue_ids: [upstream.id],
        description
      });
      const cleared = await patchIssue(database, issueId, {
        depends_on_issue_ids: [],
        description: "Updated body without dependencies"
      });
  
      expect(updated.status).toBe(200);
      expect(await updated.json()).toMatchObject({ description, title: "Patch API" });
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ description, title: "Patch API" });
      expect(cleared.status).toBe(200);
      expect(await cleared.json()).toMatchObject({
        description: "Updated body without dependencies",
        title: "Patch API"
      });
      expect(database.sqlite.query<{ dependency_issue_ids_json: string }, [number]>(
        "select dependency_issue_ids_json from issues where id=?"
      ).get(issueId)).toEqual({ dependency_issue_ids_json: "[]" });
      expect(database.sqlite.query<{ count: number }, [string]>(`
        select count(*) as count from work_relations where kind='depends_on' and source_work_id=?
      `).get(`xw:work:issues:${issueId}`)).toEqual({ count: 0 });
      expect(listEvents(database).filter((event) => event.type === "issue.planning_metadata_updated.v1")).toHaveLength(2);
    });
}
