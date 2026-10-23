import { describe, expect, test } from "bun:test";
import { basename, join } from "node:path";
import type { SQLQueryBindings } from "bun:sqlite";
import { type RunnerDatabase } from "../db/database.ts";
import { createAgentProfile } from "../db/repositories/agentProfiles.ts";
import { createDefaultRouter } from "./server.ts";
import { isProjectLoopActive } from "../runner/projectLoopManager.ts";
import { getIssueAsWork, issueIDToWorkID } from "../domain/work/issueAdapter.ts";
import { insertWorkRecord, insertWorkRelationRecord } from "../db/repositories/workLedger.ts";
import type { ExecutorProvider, ExecutorProviderId, ProviderRunInput } from "../providers/types.ts";
import { apiClient, FIXTURE_TIME, insertIssue, insertProject, insertRow, useTempDirs, useTestDatabase, waitFor } from "../testing/harness.ts";

const openFixtureDatabase = useTestDatabase("xuanwu-bun-read-api-");
const tempDir = useTempDirs("xuanwu-bun-project-cwd-");
const CAPABILITIES = ["issue_execution", "sessions", "resume_session", "interrupt", "approvals", "model_list"];
const NOT_FOUND = { message: "资源不存在" };
const RUNNING_DELETE = { message: "运行中的 issue 不能删除，请先取消执行" };

describe("Bun projects/issues read API", () => {
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

  test("creates issues with default triage status and persists creation history", async () => {
    const { database, api } = await readApi();
    createAgentProfile(database, { id: "qoder-pro", name: "Qoder Pro", provider: "qoder", model: "performance" });

    const created = await api.post<Record<string, unknown>>("/api/issues", {
      project_id: "demo",
      title: "Create API",
      description: "Issue body",
      required_mcp_capabilities: ["docs:resource:runbook"],
      recommended_mcp_capabilities: ["docs:tool:search"],
      required_skill_intents: ["xuanwu"],
      recommended_skill_intents: ["verification-before-completion"],
      priority: 4,
      agent_profile_id: "Qoder Pro!",
      source_session_id: "codex:thread-source",
      source_turn_id: "turn-source",
      source_excerpt: "讨论摘录",
      workflow_snapshot_json: '{"steps":[]}'
    });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      project_id: "demo",
      title: "Create API",
      description: "Issue body",
      status: "triage",
      priority: 4,
      agent_profile_id: "qoder-pro",
      source_session_id: "thread-source",
      source_turn_id: "turn-source",
      source_excerpt: "讨论摘录",
      required_mcp_capabilities: "[\"docs:resource:runbook\"]",
      recommended_mcp_capabilities: "[\"docs:tool:search\"]",
      required_skill_intents: "[\"xuanwu\"]",
      recommended_skill_intents: "[\"verification-before-completion\"]",
      workflow_snapshot_json: '{"steps":[]}'
    });
    expect((await api.get(`/api/issues/${created.body.id}`)).body).toMatchObject(created.body);
    expect((await api.get<Array<Record<string, unknown>>>("/api/issues?projectId=demo&status=triage")).body.map((item) => item.id))
      .toEqual([created.body.id]);
    expect(database.sqlite.query("select type, payload from issue_events order by id asc").get()).toEqual({ type: "issue.created", payload: "" });
    expect(await api.post("/api/issues", { project_id: "demo", title: "Bad profile", agent_profile_id: "missing-profile" })).toMatchObject({
      status: 400,
      body: { message: "Agent Profile \"missing-profile\" was not found" }
    });
  });

  test("reads issue MCP requirements with unregistered capability diagnostics", async () => {
    const previousRegistry = Bun.env.XUANWU_MCP_REGISTRY_JSON;
    const { database, api } = await readApi();
    Bun.env.XUANWU_MCP_REGISTRY_JSON = JSON.stringify({ servers: [{
      id: "docs",
      readiness: "ready",
      resources: [{ description: "Deployment runbook", name: "runbook" }],
      status: "enabled"
    }] });
    try {
      const issueId = addIssue(database, "MCP requirements", "triage", {
        required_mcp_capabilities_json: JSON.stringify(["docs:resource:runbook", "ghost:resource:missing"]),
        recommended_mcp_capabilities_json: JSON.stringify(["docs:tool:missing"])
      });

      expect(await api.get(`/api/issues/${issueId}`)).toMatchObject({
        status: 200,
        body: {
          required_mcp_capabilities: "[\"docs:resource:runbook\",\"ghost:resource:missing\"]",
          recommended_mcp_capabilities: "[\"docs:tool:missing\"]",
          mcp_requirements: {
            required: ["docs:resource:runbook", "ghost:resource:missing"],
            recommended: ["docs:tool:missing"],
            diagnostics: expect.arrayContaining([
              expect.objectContaining({ capability_id: "ghost:resource:missing", code: "mcp_capability_unregistered", scope: "issue.required" }),
              expect.objectContaining({ capability_id: "docs:tool:missing", code: "mcp_capability_unregistered", scope: "issue.recommended" })
            ])
          }
        }
      });
    } finally {
      if (previousRegistry === undefined) delete Bun.env.XUANWU_MCP_REGISTRY_JSON;
      else Bun.env.XUANWU_MCP_REGISTRY_JSON = previousRegistry;
    }
  });

  test("auto-run todo issue create immediately claims and starts provider session", async () => {
    const { database, api, provider } = await autoRunApi();

    const created = await api.post<Record<string, unknown>>("/api/issues", { project_id: "demo", title: "Auto todo", status: "todo" });

    expect(created.status).toBe(201);
    await waitForProviderStart(provider);
    expectClaimed(database, Number(created.body.id));
  });

  test("auto-run issue create sends the canonical body plus execution ownership contract", async () => {
    const { api, provider } = await autoRunApi();

    const created = await api.post("/api/issues", { project_id: "demo", title: "直接执行", description: "直接发给 runner", priority: 2, status: "todo" });

    expect(created.status).toBe(201);
    expect(created.body).not.toHaveProperty("template_id");
    expect(created.body).not.toHaveProperty("prompt_template");
    await waitForProviderStart(provider);
    const prompt = provider.inputs[0]?.prompt ?? "";
    expect(prompt).toContain("# 直接执行\n\n直接发给 runner");
    expect(prompt).toContain("## Xuanwu execution context (authoritative)");
    expect(prompt).toContain("RUNNER_OUTCOME: needs_user | <reason>");
  });

  test("auto-run enqueue immediately claims and starts provider session", async () => {
    const { database, api, provider } = await autoRunApi();
    const issueId = addIssue(database, "Queued", "triage");

    expect((await api.raw(`/api/issues/${issueId}/enqueue`, { method: "POST" })).status).toBe(200);
    await waitForProviderStart(provider);
    expectClaimed(database, issueId);
  });

  test("issue actions can set service tier overrides used by the next auto-run", async () => {
    const { database, api, provider } = await autoRunApi();
    const issueId = addIssue(database, "Queued fast", "triage");

    expect(await api.post(`/api/issues/${issueId}/enqueue`, { service_tier: "priority" })).toMatchObject({
      status: 200,
      body: { id: issueId, service_tier: "priority", status: "todo" }
    });
    await waitForProviderStart(provider);
    expect(provider.inputs[0]).toMatchObject({ issueId, serviceTier: "priority", serviceTierSource: "issue" });
  });

  test("auto-run patch to todo immediately claims and starts provider session", async () => {
    const { database, api, provider } = await autoRunApi();
    const issueId = addIssue(database, "Patch queued", "triage");

    expect((await api.patch(`/api/issues/${issueId}`, { status: "todo" })).status).toBe(200);
    await waitForProviderStart(provider);
    expectClaimed(database, issueId);
  });

  test("auto-run patch to in_progress queues and starts provider session", async () => {
    const { database, api, provider } = await autoRunApi();
    const issueId = addIssue(database, "Start requested", "todo");

    expect(await api.patch(`/api/issues/${issueId}`, { status: "in_progress" })).toMatchObject({ status: 200, body: { id: issueId, status: "todo" } });
    await waitForProviderStart(provider);
    expectClaimed(database, issueId, { attempt_count: 1 });
  });

  test("returns stable errors for invalid issue create payloads", async () => {
    const { api } = await readApi();
    for (const [body, status, message] of [
      [{ project_id: "missing", title: "bad" }, 404, NOT_FOUND.message],
      [{ project_id: "demo", title: "bad", status: "bogus" }, 400, "status 不合法"],
      [{ project_id: "demo", required_skill_intents: ["bad skill"], title: "bad" }, 400, "skill id 不合法: bad skill"],
      [{ project_id: "demo", required_mcp_capabilities: ["bad mcp"], title: "bad" }, 400, "MCP capability id 不合法: bad mcp"],
      [{ project_id: "demo", issue_log_mode: "verbose", title: "bad" }, 400, "issue_log_mode 只支持 normal 或 debug"]
    ] as const) {
      expect(await api.post("/api/issues", body)).toMatchObject({ status, body: { message } });
    }
  });
});

/** A database (with project "demo" unless disabled) and an in-process client over the default router. */
async function readApi(options: { autoRun?: boolean; project?: boolean; providers?: Record<string, ExecutorProvider> } = {}) {
  const database = await openFixtureDatabase();
  if (options.project !== false) addProject(database, "demo", options.autoRun ? { auto_run: 1, provider: FAKE } : {});
  return { database, api: apiClient(createDefaultRouter({ database, ...(options.providers ? { providers: options.providers } : {}) })) };
}

async function autoRunApi() {
  const provider = new FakeExecutionProvider();
  return { ...(await readApi({ autoRun: true, providers: { [provider.id]: provider } })), provider };
}

function addProject(db: RunnerDatabase, id: string, values: Record<string, SQLQueryBindings> = {}): void {
  insertProject(db, id, { name: id === "demo" ? "Demo" : id, provider: "codex", sort_order: 1, ...values });
}

function addIssue(db: RunnerDatabase, title: string, status: string, values: Record<string, SQLQueryBindings> = {}): number {
  return insertIssue(db, { title, status, source_session_id: "", ...values });
}

function addDependency(db: RunnerDatabase, issueID: number, dependencyID: number): void {
  for (const id of [issueID, dependencyID]) insertWorkRecord(db, getIssueAsWork(db, id)!);
  const key = `${issueID}:${dependencyID}`;
  insertWorkRelationRecord(db, "demo", {
    actor: { id: "read-api-test", kind: "runner" },
    audit_event_ref: `read-api-test:${key}`,
    correlation_id: `read-api-test:${key}`,
    depends_on_work_id: issueIDToWorkID(dependencyID),
    kind: "depends_on",
    occurred_at: FIXTURE_TIME,
    reason: "read API dependency fixture",
    relation_id: `read-api-dependency:${key}`,
    work_id: issueIDToWorkID(issueID)
  });
}

function expectClaimed(db: RunnerDatabase, issueId: number, extra: Record<string, unknown> = {}): void {
  expect(db.sqlite.query<Record<string, unknown>, [number]>(
    "select i.status, i.attempt_count, r.provider_session_id, r.provider_turn_id from issues i join issue_runs r on r.issue_id=i.id where i.id=?"
  ).get(issueId)).toMatchObject({
    status: "in_progress",
    provider_session_id: `fake-session-${issueId}`,
    provider_turn_id: `fake-turn-${issueId}`,
    ...extra
  });
}

const FAKE = "fake-execution-only" as ExecutorProviderId;

class FakeExecutionProvider implements ExecutorProvider {
  readonly id = FAKE;
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
  await waitFor(() => provider.inputs.length === 1, "timed out waiting for condition");
  await waitFor(() => !isProjectLoopActive("demo"), "timed out waiting for condition");
}
