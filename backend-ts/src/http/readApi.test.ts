import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createDefaultRouter } from "./server.ts";
import { isProjectLoopActive } from "../runner/projectLoopManager.ts";
import { getIssueAsWork, issueIDToWorkID } from "../domain/work/issueAdapter.ts";
import type { DependencyRelation } from "../domain/work/contracts.ts";
import { insertWorkRecord, insertWorkRelationRecord } from "../db/repositories/workLedger.ts";
import type { ExecutorProvider, ProviderRunInput } from "../providers/types.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-read-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun projects/issues read API", () => {
  test("exposes frontend-compatible project and issue read endpoints", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, { id: "demo", name: "Demo", sortOrder: 1 });
      insertProject(database, { id: "other", name: "Other", sortOrder: 2 });
      const issueId = insertIssue(database, {
        projectId: "demo",
        title: "Read API",
        status: "todo",
        sourceSessionId: "thread-a"
      });
      const blockerId = insertIssue(database, {
        projectId: "demo",
        title: "Failed blocker",
        status: "failed",
        sourceSessionId: "thread-blocker"
      });
      addDependency(database, issueId, blockerId);
      insertIssue(database, {
        projectId: "other",
        title: "Hidden",
        status: "triage",
        sourceSessionId: "thread-b"
      });

      const router = createDefaultRouter({ database });
      const projects = await router.handle(new Request(`${BASE_URL}/api/projects`));
      const project = await router.handle(new Request(`${BASE_URL}/api/projects/demo`));
      const issues = await router.handle(new Request(`${BASE_URL}/api/issues?projectId=demo&sourceSessionId=codex:thread-a`));
      const issue = await router.handle(new Request(`${BASE_URL}/api/issues/${issueId}`));

      expect(projects.status).toBe(200);
      expect(project.status).toBe(200);
      expect(await project.json()).toMatchObject({ id: "demo", cwd: "/tmp/demo" });
      const projectBody = await projects.json() as Array<Record<string, unknown>>;
      expect(projectBody.map((project) => project.id)).toEqual(["demo", "other"]);
      expect(projectBody[0]).toMatchObject({
        id: "demo",
        loop_status: "stopped",
        provider_capabilities: ["issue_execution", "sessions", "resume_session", "interrupt", "approvals", "model_list"]
      });
      expect(issues.status).toBe(200);
      expect((await issues.json() as Array<Record<string, unknown>>).map((item) => item.id)).toEqual([issueId]);
      expect(issue.status).toBe(200);
      expect(await issue.json()).toMatchObject({
        dependency: {
          compatibility: {
            relation_authority: "work_relations(kind=depends_on)",
            status_authority: "issues"
          },
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
      });
    } finally {
      database.close();
    }
  });

  test("creates and updates projects with backend-compatible responses", async () => {
    const database = await openFixtureDatabase();
    const cwd = await mkdtemp(join(tmpdir(), "codex-runner-bun-project-cwd-"));
    tempRoots.push(cwd);
    try {
      const router = createDefaultRouter({ database });

      const created = await router.handle(new Request(`${BASE_URL}/api/projects`, {
        method: "POST",
        body: JSON.stringify({ id: "demo", cwd, default_skill_policy: { allowed: ["codex-issue-runner"] } }),
        headers: { "content-type": "application/json" }
      }));
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({
        id: "demo",
        name: basename(cwd),
        cwd,
        provider: "codex",
        default_skill_policy: "{\"allowed\":[\"codex-issue-runner\"]}",
        auto_run: 1,
        pi_managed: 1,
        model: "codex-default",
        approval_policy: "never",
        sandbox: "workspace-write",
        sort_order: 1,
        loop_status: "stopped",
        provider_capabilities: ["issue_execution", "sessions", "resume_session", "interrupt", "approvals", "model_list"]
      });

      const patched = await router.handle(new Request(`${BASE_URL}/api/projects/demo`, {
        method: "PATCH",
        body: JSON.stringify({ default_service_tier: "priority", default_skill_policy: { recommended: ["verification-before-completion"] }, name: "Renamed", provider: "CODEX" }),
        headers: { "content-type": "application/json" }
      }));
      expect(patched.status).toBe(200);
      expect(await patched.json()).toMatchObject({
        default_service_tier: "priority",
        default_skill_policy: "{\"recommended\":[\"verification-before-completion\"]}",
        id: "demo",
        name: "Renamed",
        provider: "codex",
        auto_run: 1,
        pi_managed: 1
      });

      const cannotDisableTakeover = await router.handle(new Request(`${BASE_URL}/api/projects/demo`, {
        method: "PATCH",
        body: JSON.stringify({ auto_run: 0 }),
        headers: { "content-type": "application/json" }
      }));
      expect(cannotDisableTakeover.status).toBe(200);
      expect(await cannotDisableTakeover.json()).toMatchObject({ auto_run: 1, pi_managed: 1 });

      const duplicateCWD = await router.handle(new Request(`${BASE_URL}/api/projects`, {
        method: "POST",
        body: JSON.stringify({ id: "demo", name: "Manual", cwd, auto_run: 1, model: "gpt-5.5", sandbox: "danger-full-access" }),
        headers: { "content-type": "application/json" }
      }));
      expect(duplicateCWD.status).toBe(201);
      expect(await duplicateCWD.json()).toMatchObject({
        id: "demo",
        name: "Manual",
        cwd,
        auto_run: 1,
        pi_managed: 1,
        model: "gpt-5.5",
        sandbox: "danger-full-access",
        sort_order: 1
      });

      const projects = await router.handle(new Request(`${BASE_URL}/api/projects`));
      expect((await projects.json() as Array<Record<string, unknown>>).map((item) => item.id)).toEqual(["demo"]);
    } finally {
      database.close();
    }
  });

  test("matches legacy API failure paths for project writes", async () => {
    const database = await openFixtureDatabase();
    const cwd = await mkdtemp(join(tmpdir(), "codex-runner-bun-project-cwd-"));
    tempRoots.push(cwd);
    try {
      const router = createDefaultRouter({ database });
      const withoutID = await router.handle(new Request(`${BASE_URL}/api/projects`, {
        method: "POST", body: JSON.stringify({ cwd })
      }));
      const invalidCWD = await router.handle(new Request(`${BASE_URL}/api/projects`, {
        method: "POST", body: JSON.stringify({ id: "bad", cwd: join(cwd, "missing") })
      }));
      await router.handle(new Request(`${BASE_URL}/api/projects`, {
        method: "POST", body: JSON.stringify({ id: "demo", cwd })
      }));
      const duplicateCWD = await mkdtemp(join(tmpdir(), "codex-runner-bun-project-cwd-"));
      tempRoots.push(duplicateCWD);
      const duplicateID = await router.handle(new Request(`${BASE_URL}/api/projects`, {
        method: "POST", body: JSON.stringify({ id: "demo", cwd: duplicateCWD })
      }));
      const missing = await router.handle(new Request(`${BASE_URL}/api/projects/missing`, {
        method: "PATCH", body: JSON.stringify({ name: "Missing" })
      }));

      expect(withoutID.status).toBe(400);
      expect(await withoutID.json()).toEqual({ message: "project id 不能为空" });
      expect(invalidCWD.status).toBe(400);
      expect(await invalidCWD.json()).toEqual({ message: "cwd 不存在" });
      expect(duplicateID.status).toBe(400);
      expect((await duplicateID.json() as { message: string }).message).toContain("UNIQUE constraint failed: projects.id");
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ message: "资源不存在" });
    } finally {
      database.close();
    }
  });

  test("provides remaining auxiliary endpoints and removes Issue template routes", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });
      const templates = await router.handle(new Request(`${BASE_URL}/api/issue-templates`));
      const cron = await router.handle(new Request(`${BASE_URL}/api/cron-tasks`));
      const profiles = await router.handle(new Request(`${BASE_URL}/api/agent-profiles`));

      expect(templates.status).toBe(404);
      expect(cron.status).toBe(308);
      expect(cron.headers.get("location")).toBe("/api/automations");
      expect(await cron.json()).toMatchObject({
        contract: "xw.automation-target-primary.v1",
        deprecated: true,
        location: "/api/automations"
      });
      expect(profiles.status).toBe(200);
      expect(await profiles.json()).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("matches legacy API failure status for invalid and missing issue ids", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });
      const invalid = await router.handle(new Request(`${BASE_URL}/api/issues/not-a-number`));
      const missing = await router.handle(new Request(`${BASE_URL}/api/issues/404`));
      const unsupported = await router.handle(new Request(`${BASE_URL}/api/issues`, { method: "DELETE" }));

      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ message: "issue id 不合法" });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ message: "资源不存在" });
      expect(unsupported.status).toBe(405);
      expect(await unsupported.json()).toEqual({ message: "method not allowed" });
    } finally {
      database.close();
    }
  });

  test("deletes non-running issues and cascades issue history", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, { id: "demo", name: "Demo", sortOrder: 1 });
      const issueId = insertIssue(database, {
        projectId: "demo",
        title: "Delete me",
        status: "cancelled",
        sourceSessionId: ""
      });
      database.sqlite.run(
        `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
        [issueId, "issue.comment", '{"body":"old"}', "2026-01-01T00:00:00Z"]
      );
      database.sqlite.run(
        `insert into issue_runs (id, issue_id, attempt, status, started_at, ended_at)
         values (?, ?, ?, ?, ?, ?)`,
        [`issue-${issueId}-attempt-1`, issueId, 1, "cancelled", "2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z"]
      );
      const router = createDefaultRouter({ database });

      const deleted = await router.handle(new Request(`${BASE_URL}/api/issues/${issueId}`, { method: "DELETE" }));
      const readBack = await router.handle(new Request(`${BASE_URL}/api/issues/${issueId}`));
      const rows = database.sqlite.query<{ count: number }, [number]>(
        `select count(*) as count from issue_events where issue_id=?
         union all
         select count(*) as count from issue_runs where issue_id=?`
      ).all(issueId, issueId).map(row => row.count);

      expect(deleted.status).toBe(204);
      expect(readBack.status).toBe(404);
      expect(rows).toEqual([0, 0]);
    } finally {
      database.close();
    }
  });

  test("rejects deleting in-progress issues", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, { id: "demo", name: "Demo", sortOrder: 1 });
      const issueId = insertIssue(database, {
        projectId: "demo",
        title: "Running",
        status: "in_progress",
        sourceSessionId: ""
      });
      const router = createDefaultRouter({ database });

      const deleted = await router.handle(new Request(`${BASE_URL}/api/issues/${issueId}`, { method: "DELETE" }));
      const readBack = await router.handle(new Request(`${BASE_URL}/api/issues/${issueId}`));

      expect(deleted.status).toBe(400);
      expect(await deleted.json()).toEqual({ message: "运行中的 issue 不能删除，请先取消执行" });
      expect(readBack.status).toBe(200);
    } finally {
      database.close();
    }
  });

  test("rejects deleting issues with an open run even when issue status drifted", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, { id: "demo", name: "Demo", sortOrder: 1 });
      const issueId = insertIssue(database, {
        projectId: "demo",
        title: "Open run",
        status: "todo",
        sourceSessionId: ""
      });
      database.sqlite.run(
        `insert into issue_runs (id, issue_id, attempt, status, started_at, ended_at)
         values (?, ?, ?, ?, ?, '')`,
        [`issue-${issueId}-attempt-1`, issueId, 1, "in_progress", "2026-01-01T00:00:00Z"]
      );
      const router = createDefaultRouter({ database });

      const deleted = await router.handle(new Request(`${BASE_URL}/api/issues/${issueId}`, { method: "DELETE" }));
      const readBack = await router.handle(new Request(`${BASE_URL}/api/issues/${issueId}`));

      expect(deleted.status).toBe(400);
      expect(await deleted.json()).toEqual({ message: "运行中的 issue 不能删除，请先取消执行" });
      expect(readBack.status).toBe(200);
    } finally {
      database.close();
    }
  });

  test("creates issues with default triage status and persists creation history", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, { id: "demo", name: "Demo", sortOrder: 1 });
      const router = createDefaultRouter({ database });

      const created = await router.handle(new Request(`${BASE_URL}/api/issues`, {
        method: "POST",
        body: JSON.stringify({
          project_id: "demo",
          title: "Create API",
          description: "Issue body",
          required_mcp_capabilities: ["docs:resource:runbook"],
          recommended_mcp_capabilities: ["docs:tool:search"],
          required_skill_intents: ["codex-issue-runner"],
          recommended_skill_intents: ["verification-before-completion"],
          priority: 4,
          agent_profile_id: "Codex Pro!",
          source_session_id: "codex:thread-source",
          source_turn_id: "turn-source",
          source_excerpt: "讨论摘录",
          workflow_snapshot_json: '{"steps":[]}'
        }),
        headers: { "content-type": "application/json" }
      }));
      const createdIssue = await created.json() as Record<string, unknown>;
      const readBack = await router.handle(new Request(`${BASE_URL}/api/issues/${createdIssue.id}`));
      const list = await router.handle(new Request(`${BASE_URL}/api/issues?projectId=demo&status=triage`));
      const event = database.sqlite.query<{ type: string; payload: string }, []>(
        "select type, payload from issue_events order by id asc"
      ).get();

      expect(created.status).toBe(201);
      expect(createdIssue).toMatchObject({
        project_id: "demo",
        title: "Create API",
        description: "Issue body",
        status: "triage",
        priority: 4,
        agent_profile_id: "codex-pro",
        source_session_id: "thread-source",
        source_turn_id: "turn-source",
        source_excerpt: "讨论摘录",
        required_mcp_capabilities: "[\"docs:resource:runbook\"]",
        recommended_mcp_capabilities: "[\"docs:tool:search\"]",
        required_skill_intents: "[\"codex-issue-runner\"]",
        recommended_skill_intents: "[\"verification-before-completion\"]",
        workflow_snapshot_json: '{"steps":[]}'
      });
      expect(await readBack.json()).toMatchObject(createdIssue);
      expect((await list.json() as Array<Record<string, unknown>>).map((item) => item.id)).toEqual([createdIssue.id]);
      expect(event).toEqual({ type: "issue.created", payload: "" });
    } finally {
      database.close();
    }
  });

  test("reads issue MCP requirements with unregistered capability diagnostics", async () => {
    const previousRegistry = Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON;
    const database = await openFixtureDatabase();
    Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON = JSON.stringify({ servers: [{
      id: "docs",
      readiness: "ready",
      resources: [{ description: "Deployment runbook", name: "runbook" }],
      status: "enabled"
    }] });
    try {
      insertProject(database, { id: "demo", name: "Demo", sortOrder: 1 });
      const issueId = insertIssue(database, {
        projectId: "demo",
        sourceSessionId: "",
        status: "triage",
        title: "MCP requirements"
      });
      database.sqlite.run(
        `update issues set required_mcp_capabilities_json=?, recommended_mcp_capabilities_json=? where id=?`,
        [JSON.stringify(["docs:resource:runbook", "ghost:resource:missing"]), JSON.stringify(["docs:tool:missing"]), issueId]
      );

      const router = createDefaultRouter({ database });
      const response = await router.handle(new Request(`${BASE_URL}/api/issues/${issueId}`));
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        required_mcp_capabilities: "[\"docs:resource:runbook\",\"ghost:resource:missing\"]",
        recommended_mcp_capabilities: "[\"docs:tool:missing\"]",
        mcp_requirements: {
          required: ["docs:resource:runbook", "ghost:resource:missing"],
          recommended: ["docs:tool:missing"],
          diagnostics: expect.arrayContaining([
            expect.objectContaining({
              capability_id: "ghost:resource:missing",
              code: "mcp_capability_unregistered",
              scope: "issue.required"
            }),
            expect.objectContaining({
              capability_id: "docs:tool:missing",
              code: "mcp_capability_unregistered",
              scope: "issue.recommended"
            })
          ])
        }
      });
    } finally {
      if (previousRegistry === undefined) delete Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON;
      else Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON = previousRegistry;
      database.close();
    }
  });

  test("auto-run todo issue create immediately claims and starts provider session", async () => {
    const database = await openFixtureDatabase();
    const provider = new FakeExecutionProvider();
    try {
      insertProject(database, { id: "demo", name: "Demo", sortOrder: 1, autoRun: 1, provider: provider.id });
      const router = createDefaultRouter({ database, providers: { [provider.id]: provider } });

      const created = await router.handle(new Request(`${BASE_URL}/api/issues`, {
        method: "POST",
        body: JSON.stringify({ project_id: "demo", title: "Auto todo", status: "todo" }),
        headers: { "content-type": "application/json" }
      }));

      expect(created.status).toBe(201);
      const body = await created.json() as Record<string, unknown>;
      await waitForProviderStart(provider);
      const row = database.sqlite.query<Record<string, unknown>, [number]>(
        `select i.status, r.provider_session_id, r.provider_turn_id
         from issues i join issue_runs r on r.issue_id=i.id where i.id=?`
      ).get(Number(body.id));
      expect(row).toMatchObject({
        status: "in_progress",
        provider_session_id: `fake-session-${body.id}`,
        provider_turn_id: `fake-turn-${body.id}`
      });
    } finally {
      database.close();
    }
  });

  test("auto-run issue create sends only the canonical title and description", async () => {
    const database = await openFixtureDatabase();
    const provider = new FakeExecutionProvider();
    try {
      insertProject(database, { id: "demo", name: "Demo", sortOrder: 1, autoRun: 1, provider: provider.id });
      const router = createDefaultRouter({ database, providers: { [provider.id]: provider } });

      const created = await router.handle(new Request(`${BASE_URL}/api/issues`, {
        method: "POST",
        body: JSON.stringify({
          project_id: "demo",
          title: "直接执行",
          description: "直接发给 runner",
          priority: 2,
          status: "todo"
        }),
        headers: { "content-type": "application/json" }
      }));

      expect(created.status).toBe(201);
      const body = await created.json() as Record<string, unknown>;
      expect(body).not.toHaveProperty("template_id");
      expect(body).not.toHaveProperty("prompt_template");
      await waitForProviderStart(provider);
      const prompt = provider.inputs[0]?.prompt ?? "";
      expect(prompt).toBe("# 直接执行\n\n直接发给 runner");
    } finally {
      database.close();
    }
  });

  test("auto-run enqueue immediately claims and starts provider session", async () => {
    const database = await openFixtureDatabase();
    const provider = new FakeExecutionProvider();
    try {
      insertProject(database, { id: "demo", name: "Demo", sortOrder: 1, autoRun: 1, provider: provider.id });
      const issueId = insertIssue(database, { projectId: "demo", title: "Queued", status: "triage", sourceSessionId: "" });
      const router = createDefaultRouter({ database, providers: { [provider.id]: provider } });

      const enqueued = await router.handle(new Request(`${BASE_URL}/api/issues/${issueId}/enqueue`, { method: "POST" }));

      expect(enqueued.status).toBe(200);
      await waitForProviderStart(provider);
      const row = database.sqlite.query<Record<string, unknown>, [number]>(
        `select i.status, r.provider_session_id, r.provider_turn_id
         from issues i join issue_runs r on r.issue_id=i.id where i.id=?`
      ).get(issueId);
      expect(row).toMatchObject({
        status: "in_progress",
        provider_session_id: `fake-session-${issueId}`,
        provider_turn_id: `fake-turn-${issueId}`
      });
    } finally {
      database.close();
    }
  });

  test("issue actions can set service tier overrides used by the next auto-run", async () => {
    const database = await openFixtureDatabase();
    const provider = new FakeExecutionProvider();
    try {
      insertProject(database, { id: "demo", name: "Demo", sortOrder: 1, autoRun: 1, provider: provider.id });
      const issueId = insertIssue(database, { projectId: "demo", title: "Queued fast", status: "triage", sourceSessionId: "" });
      const router = createDefaultRouter({ database, providers: { [provider.id]: provider } });

      const enqueued = await router.handle(new Request(`${BASE_URL}/api/issues/${issueId}/enqueue`, {
        method: "POST",
        body: JSON.stringify({ service_tier: "priority" }),
        headers: { "content-type": "application/json" }
      }));

      expect(enqueued.status).toBe(200);
      expect(await enqueued.json()).toMatchObject({ id: issueId, service_tier: "priority", status: "todo" });
      await waitForProviderStart(provider);
      expect(provider.inputs[0]).toMatchObject({
        issueId,
        serviceTier: "priority",
        serviceTierSource: "issue"
      });
    } finally {
      database.close();
    }
  });

  test("auto-run patch to todo immediately claims and starts provider session", async () => {
    const database = await openFixtureDatabase();
    const provider = new FakeExecutionProvider();
    try {
      insertProject(database, { id: "demo", name: "Demo", sortOrder: 1, autoRun: 1, provider: provider.id });
      const issueId = insertIssue(database, { projectId: "demo", title: "Patch queued", status: "triage", sourceSessionId: "" });
      const router = createDefaultRouter({ database, providers: { [provider.id]: provider } });

      const patched = await router.handle(new Request(`${BASE_URL}/api/issues/${issueId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "todo" }),
        headers: { "content-type": "application/json" }
      }));

      expect(patched.status).toBe(200);
      await waitForProviderStart(provider);
      const row = database.sqlite.query<Record<string, unknown>, [number]>(
        `select i.status, r.provider_session_id, r.provider_turn_id
         from issues i join issue_runs r on r.issue_id=i.id where i.id=?`
      ).get(issueId);
      expect(row).toMatchObject({
        status: "in_progress",
        provider_session_id: `fake-session-${issueId}`,
        provider_turn_id: `fake-turn-${issueId}`
      });
    } finally {
      database.close();
    }
  });

  test("auto-run patch to in_progress queues and starts provider session", async () => {
    const database = await openFixtureDatabase();
    const provider = new FakeExecutionProvider();
    try {
      insertProject(database, { id: "demo", name: "Demo", sortOrder: 1, autoRun: 1, provider: provider.id });
      const issueId = insertIssue(database, { projectId: "demo", title: "Start requested", status: "todo", sourceSessionId: "" });
      const router = createDefaultRouter({ database, providers: { [provider.id]: provider } });

      const patched = await router.handle(new Request(`${BASE_URL}/api/issues/${issueId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "in_progress" }),
        headers: { "content-type": "application/json" }
      }));

      expect(patched.status).toBe(200);
      expect(await patched.json()).toMatchObject({ id: issueId, status: "todo" });
      await waitForProviderStart(provider);
      const row = database.sqlite.query<Record<string, unknown>, [number]>(
        `select i.status, i.attempt_count, r.provider_session_id, r.provider_turn_id
         from issues i join issue_runs r on r.issue_id=i.id where i.id=?`
      ).get(issueId);
      expect(row).toMatchObject({
        status: "in_progress",
        attempt_count: 1,
        provider_session_id: `fake-session-${issueId}`,
        provider_turn_id: `fake-turn-${issueId}`
      });
    } finally {
      database.close();
    }
  });

  test("returns stable errors for invalid issue create payloads", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, { id: "demo", name: "Demo", sortOrder: 1 });
      const router = createDefaultRouter({ database });
      const missingProject = await router.handle(new Request(`${BASE_URL}/api/issues`, {
        method: "POST",
        body: JSON.stringify({ project_id: "missing", title: "bad" })
      }));
      const invalidStatus = await router.handle(new Request(`${BASE_URL}/api/issues`, {
        method: "POST",
        body: JSON.stringify({ project_id: "demo", title: "bad", status: "bogus" })
      }));
      const invalidSkill = await router.handle(new Request(`${BASE_URL}/api/issues`, {
        method: "POST",
        body: JSON.stringify({ project_id: "demo", required_skill_intents: ["bad skill"], title: "bad" })
      }));
      const invalidMcp = await router.handle(new Request(`${BASE_URL}/api/issues`, {
        method: "POST",
        body: JSON.stringify({ project_id: "demo", required_mcp_capabilities: ["bad mcp"], title: "bad" })
      }));
      const invalidLogMode = await router.handle(new Request(`${BASE_URL}/api/issues`, {
        method: "POST",
        body: JSON.stringify({ project_id: "demo", issue_log_mode: "verbose", title: "bad" })
      }));

      expect(missingProject.status).toBe(404);
      expect(await missingProject.json()).toEqual({ message: "资源不存在" });
      expect(invalidStatus.status).toBe(400);
      expect(await invalidStatus.json()).toEqual({ message: "status 不合法" });
      expect(invalidSkill.status).toBe(400);
      expect(await invalidSkill.json()).toEqual({ message: "skill id 不合法: bad skill" });
      expect(invalidMcp.status).toBe(400);
      expect(await invalidMcp.json()).toEqual({ message: "MCP capability id 不合法: bad mcp" });
      expect(invalidLogMode.status).toBe(400);
      expect(await invalidLogMode.json()).toEqual({ message: "issue_log_mode 只支持 normal 或 debug" });
    } finally {
      database.close();
    }
  });
});

type ProjectFixture = { autoRun?: number; id: string; name: string; provider?: string; sortOrder: number };
type IssueFixture = { projectId: string; sourceSessionId: string; status: string; title: string };

function insertProject(db: RunnerDatabase, project: ProjectFixture): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, auto_run, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [project.id, project.name, `/tmp/${project.id}`, project.provider ?? "codex", project.autoRun ?? 0,
      project.sortOrder, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, issue: IssueFixture): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, source_session_id, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [issue.projectId, issue.title, issue.status, issue.sourceSessionId, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing inserted issue id");
  return row.id;
}

function addDependency(db: RunnerDatabase, issueID: number, dependencyID: number): void {
  for (const id of [issueID, dependencyID]) {
    const work = getIssueAsWork(db, id);
    if (!work) throw new Error(`missing issue ${id}`);
    insertWorkRecord(db, work);
  }
  const relation: DependencyRelation = {
    actor: { id: "read-api-test", kind: "runner" },
    audit_event_ref: `read-api-test:${issueID}:${dependencyID}`,
    correlation_id: `read-api-test:${issueID}:${dependencyID}`,
    depends_on_work_id: issueIDToWorkID(dependencyID),
    kind: "depends_on",
    occurred_at: "2026-01-01T00:00:00Z",
    reason: "read API dependency fixture",
    relation_id: `read-api-dependency:${issueID}:${dependencyID}`,
    work_id: issueIDToWorkID(issueID)
  };
  insertWorkRelationRecord(db, "demo", relation);
}

class FakeExecutionProvider implements ExecutorProvider {
  readonly id = "fake-execution-only" as const;
  readonly capabilities = ["issue_execution"] as const;
  readonly inputs: ProviderRunInput[] = [];

  async run(input: ProviderRunInput) {
    this.inputs.push(input);
    return {
      runId: `fake-run-${input.issueId}`,
      session: { provider: this.id, sessionId: `fake-session-${input.issueId}`, turnId: `fake-turn-${input.issueId}` }
    };
  }
}

async function waitForProviderStart(provider: FakeExecutionProvider): Promise<void> {
  await waitFor(() => provider.inputs.length === 1);
  await waitFor(() => !isProjectLoopActive("demo"));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("timed out waiting for condition");
}
