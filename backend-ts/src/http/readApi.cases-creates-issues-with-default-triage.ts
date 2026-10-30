import { expect, test } from "bun:test";
import { createAgentProfile } from "../db/repositories/agentProfiles.ts";
import type { TestFixture } from "./readApi.testFixture.ts";

export function registerCreatesIssuesWithDefaultTriageCases(testScope: TestFixture) {
  const { NOT_FOUND, readApi, autoRunApi, addIssue, expectClaimed, waitForProviderStart } = testScope;
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
}
