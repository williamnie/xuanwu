import { expect, test } from "bun:test";
import { basename, join } from "node:path";
import { FIXTURE_TIME, insertRow } from "../testing/harness.ts";
import type { TestFixture } from "./readApi.testFixture.ts";

export function registerExposesFrontendCompatibleProjectAndCases(testScope: TestFixture) {
  const { tempDir, CAPABILITIES, NOT_FOUND, RUNNING_DELETE, readApi, addProject, addIssue, addDependency } = testScope;
  test("exposes frontend-compatible project and issue read endpoints", async () => {
      const { database, api } = await readApi();
      addProject(database, "other", { name: "Other", sort_order: 2 });
      const issueId = addIssue(database, "Read API", "todo", { source_session_id: "thread-a" });
      const blockerId = addIssue(database, "Failed blocker", "failed", { source_session_id: "thread-blocker" });
      addDependency(database, issueId, blockerId);
      addIssue(database, "Hidden", "triage", { project_id: "other", source_session_id: "thread-b" });
  
      const projects = await api.get<Array<Record<string, unknown>>>("/api/projects");
      expect(await api.get("/api/projects/demo")).toMatchObject({ status: 200, body: { id: "demo", cwd: "/tmp/demo" } });
      expect(projects.status).toBe(200);
      expect(projects.body.map((project) => project.id)).toEqual(["demo", "other"]);
      expect(projects.body[0]).toMatchObject({ id: "demo", loop_status: "stopped", provider_capabilities: CAPABILITIES });
      const issues = await api.get<Array<Record<string, unknown>>>("/api/issues?projectId=demo&sourceSessionId=codex:thread-a");
      expect(issues.status).toBe(200);
      expect(issues.body.map((item) => item.id)).toEqual([issueId]);
      expect(await api.get(`/api/issues/${issueId}`)).toMatchObject({
        status: 200,
        body: {
          dependency: {
            compatibility: { relation_authority: "work_relations(kind=depends_on)", status_authority: "issues" },
            direct_dependencies: [{ issue_id: blockerId, status: "failed" }],
            ready: false,
            reason: "failed_dependency",
            root_blockers: [{ issue_id: blockerId, status: "failed" }]
          },
          id: issueId,
          project_id: "demo",
          title: "Read API",
          source_session_id: "thread-a",
          comment_count: 0
        }
      });
    });
  
  test("creates and updates projects with backend-compatible responses", async () => {
      const { api } = await readApi({ project: false });
      const cwd = await tempDir();
  
      expect(await api.post("/api/projects", { id: "demo", cwd, default_skill_policy: { allowed: ["xuanwu"] } })).toMatchObject({
        status: 201,
        body: {
          id: "demo",
          name: basename(cwd),
          cwd,
          provider: "codex",
          default_skill_policy: "{\"allowed\":[\"xuanwu\"]}",
          auto_run: 1,
          pi_managed: 1,
          model: "codex-default",
          approval_policy: "never",
          sandbox: "danger-full-access",
          execution_policy: { contract: "xw.execution-policy.v1", access: "unrestricted-host", approval: "unattended" },
          sort_order: 1,
          loop_status: "stopped",
          provider_capabilities: CAPABILITIES
        }
      });
      expect(await api.patch("/api/projects/demo", {
        default_service_tier: "priority",
        default_skill_policy: { recommended: ["verification-before-completion"] },
        name: "Renamed",
        provider: "CODEX"
      })).toMatchObject({
        status: 200,
        body: {
          default_service_tier: "priority",
          default_skill_policy: "{\"recommended\":[\"verification-before-completion\"]}",
          id: "demo",
          name: "Renamed",
          provider: "codex",
          auto_run: 1,
          pi_managed: 1
        }
      });
      expect(await api.patch("/api/projects/demo", { auto_run: 0 })).toMatchObject({ status: 200, body: { auto_run: 1, pi_managed: 1 } });
      expect(await api.post("/api/projects", {
        id: "demo", name: "Manual", cwd, auto_run: 1, model: "gpt-5.5", sandbox: "danger-full-access"
      })).toMatchObject({
        status: 201,
        body: { id: "demo", name: "Manual", cwd, auto_run: 1, pi_managed: 1, model: "gpt-5.5", sandbox: "danger-full-access", sort_order: 1 }
      });
      expect((await api.get<Array<Record<string, unknown>>>("/api/projects")).body.map((item) => item.id)).toEqual(["demo"]);
    });
  
  test("matches legacy API failure paths for project writes", async () => {
      const { api } = await readApi({ project: false });
      const cwd = await tempDir();
      const withoutID = await api.post("/api/projects", { cwd });
      const invalidCWD = await api.post("/api/projects", { id: "bad", cwd: join(cwd, "missing") });
      const invalidProfile = await api.post("/api/projects", { id: "bad-profile", cwd, default_agent_profile_id: "missing-profile" });
      await api.post("/api/projects", { id: "demo", cwd });
      const duplicateID = await api.post<{ message: string }>("/api/projects", { id: "demo", cwd: await tempDir() });
  
      expect(withoutID).toMatchObject({ status: 400, body: { message: "project id 不能为空" } });
      expect(invalidCWD).toMatchObject({ status: 400, body: { message: "cwd 不存在" } });
      expect(invalidProfile).toMatchObject({ status: 400, body: { message: "Agent Profile \"missing-profile\" was not found" } });
      expect(duplicateID.status).toBe(400);
      expect(duplicateID.body.message).toContain("UNIQUE constraint failed: projects.id");
      expect(await api.patch("/api/projects/missing", { name: "Missing" })).toEqual(expect.objectContaining({ status: 404, body: NOT_FOUND }));
    });
  
  test("provides remaining auxiliary endpoints and removes Issue template routes", async () => {
      const { api } = await readApi({ project: false });
      const cron = await api.get("/api/cron-tasks");
      const profiles = await api.get<Array<{ id: string; provider: string }>>("/api/agent-profiles");
  
      expect((await api.get("/api/issue-templates")).status).toBe(404);
      expect(cron.status).toBe(308);
      expect(cron.headers.get("location")).toBe("/api/automations");
      expect(cron.body).toMatchObject({ contract: "xw.automation-target-primary.v1", deprecated: true, location: "/api/automations" });
      expect(profiles.status).toBe(200);
      expect(profiles.body.map(({ id, provider }) => ({ id, provider }))).toEqual([
        { id: "xuanwu-provider-claude", provider: "claude" },
        { id: "xuanwu-provider-codex", provider: "codex" },
        { id: "xuanwu-provider-pi", provider: "pi-coding-agent" },
        { id: "xuanwu-provider-qoder", provider: "qoder" }
      ]);
    });
  
  test("persists and reads back Qoder project provider, profile, and model without Codex defaults", async () => {
      const { api } = await readApi({ project: false });
      const cwd = await tempDir();
      const created = await api.post("/api/projects", {
        id: "qoder-demo", cwd, provider: "qoder", model: "performance", default_agent_profile_id: "xuanwu-provider-qoder"
      });
  
      expect(created).toMatchObject({
        status: 201,
        body: {
          id: "qoder-demo",
          provider: "qoder",
          model: "performance",
          default_agent_profile_id: "xuanwu-provider-qoder",
          default_agent_profile: { id: "xuanwu-provider-qoder", provider: "qoder", model: "" }
        }
      });
      expect((await api.get("/api/projects/qoder-demo")).body).toMatchObject({
        provider: "qoder", model: "performance", default_agent_profile_id: "xuanwu-provider-qoder"
      });
      expect(JSON.stringify((await api.get("/api/agent-profiles")).body)).not.toContain('"provider":"qoder","model":"codex-default"');
    });
  
  test("matches legacy API failure status for invalid and missing issue ids", async () => {
      const { api } = await readApi({ project: false });
  
      expect(await api.get("/api/issues/not-a-number")).toMatchObject({ status: 400, body: { message: "issue id 不合法" } });
      expect(await api.get("/api/issues/404")).toMatchObject({ status: 404, body: NOT_FOUND });
      expect(await api.delete("/api/issues")).toMatchObject({ status: 405, body: { message: "method not allowed" } });
    });
  
  test("deletes non-running issues and cascades issue history", async () => {
      const { database, api } = await readApi();
      const issueId = addIssue(database, "Delete me", "cancelled");
      insertRow(database, "issue_events", { issue_id: issueId, type: "issue.comment", payload: '{"body":"old"}', created_at: FIXTURE_TIME });
      insertRow(database, "issue_runs", {
        id: `issue-${issueId}-attempt-1`, issue_id: issueId, attempt: 1, status: "cancelled", started_at: FIXTURE_TIME, ended_at: "2026-01-01T00:01:00Z"
      });
  
      expect((await api.delete(`/api/issues/${issueId}`)).status).toBe(204);
      expect((await api.get(`/api/issues/${issueId}`)).status).toBe(404);
      expect(database.sqlite.query<{ count: number }, [number, number]>(
        "select count(*) as count from issue_events where issue_id=? union all select count(*) as count from issue_runs where issue_id=?"
      ).all(issueId, issueId).map((row) => row.count)).toEqual([0, 0]);
    });
  
  test("rejects deleting in-progress issues", async () => {
      const { database, api } = await readApi();
      const issueId = addIssue(database, "Running", "in_progress");
  
      expect(await api.delete(`/api/issues/${issueId}`)).toMatchObject({ status: 400, body: RUNNING_DELETE });
      expect((await api.get(`/api/issues/${issueId}`)).status).toBe(200);
    });
  
  test("rejects deleting issues with an open run even when issue status drifted", async () => {
      const { database, api } = await readApi();
      const issueId = addIssue(database, "Open run", "todo");
      insertRow(database, "issue_runs", {
        id: `issue-${issueId}-attempt-1`, issue_id: issueId, attempt: 1, status: "in_progress", started_at: FIXTURE_TIME, ended_at: ""
      });
  
      expect(await api.delete(`/api/issues/${issueId}`)).toMatchObject({ status: 400, body: RUNNING_DELETE });
      expect((await api.get(`/api/issues/${issueId}`)).status).toBe(200);
    });
}
