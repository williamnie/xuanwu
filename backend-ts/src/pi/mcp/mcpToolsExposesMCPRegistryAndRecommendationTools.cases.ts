import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { listPiActionEvents, listPiActions } from "../../db/repositories/pi.ts";
import { getIssue } from "../../db/repositories/issues.ts";
import { getProject, type Project } from "../../db/repositories/projects.ts";
import { createPiRunnerActions } from "../runnerTools/runnerActions.ts";
import { createPiRunnerActionTools } from "../runnerTools/runnerActionTools.ts";

import { tempRoots, previousRegistry, openFixture, writeRealMcpServer, offlineServer, docsServer, realMcpServer, missingMcpServer, REAL_MCP_SERVER_SCRIPT, toolNames, toolByName, runTool } from "./mcpToolsTestFixtures.ts";

export function registerExposesMCPRegistryAndRecommendationTools() {
test("exposes MCP registry and recommendation tools to PI", async () => {
    const { db, project } = await openFixture();
    Bun.env.XUANWU_MCP_REGISTRY_JSON = JSON.stringify({ servers: [docsServer()] });
    try {
      const tools = createPiRunnerActionTools(createPiRunnerActions(db, { project }));

      expect(toolNames(tools)).toEqual(expect.arrayContaining([
        "mcp_registry_list",
        "mcp_capability_read",
        "mcp_requirement_recommend",
        "mcp_resource_list",
        "mcp_resource_read",
        "mcp_tool_call"
      ]));
      expect(validateToolArguments(toolByName(tools, "mcp_capability_read") as never, {
        name: "mcp_capability_read",
        arguments: { capability_id: "docs:resource:runbook" }
      } as never)).toEqual({ capability_id: "docs:resource:runbook" });

      const registry = await runTool(tools, "mcp_registry_list", {});
      const recommended = await runTool(tools, "mcp_requirement_recommend", {
        description: "Need deployment runbook context",
        project_id: project.id,
        title: "Runbook"
      });

      expect(registry.details.items[0]).toMatchObject({ id: "docs", readiness: "ready" });
      expect(recommended.details.items.map((item: { id: string }) => item.id)).toContain("docs:resource:runbook");
    } finally {
      db.close();
    }
  });

test("fails closed when configured MCP tools have no executable transport", async () => {
    const { db, project } = await openFixture();
    Bun.env.XUANWU_MCP_REGISTRY_JSON = JSON.stringify({ servers: [docsServer()] });
    try {
      const tools = createPiRunnerActionTools(createPiRunnerActions(db, {
        authorization: {
          allowed_mcp_capabilities: ["docs:tool:search"],
          authorizedActions: [{ action_type: "mcp.tool.call", project_id: project.id }],
          mode: "delegated",
          scope: { project_id: project.id }
        },
        conversationID: "conversation-mcp-tool",
        project
      }));

      const result = await runTool(tools, "mcp_tool_call", {
        capability_id: "docs:tool:search",
        input: { query: "deploy" }
      });
      const action = listPiActions(db).find((item) => item.action_type === "mcp.tool.call");
      const audit = listPiActionEvents(db, { eventType: "tool_call_audit" }).at(-1);

      expect(result.details).toMatchObject({
        error: { code: "mcp_server_unavailable", message: "MCP server has no executable transport" },
        status: "failed"
      });
      expect(action).toMatchObject({
        gate_decision: "execute",
        project_id: project.id,
        source: "pi_mcp_tool",
        status: "completed"
      });
      expect(listPiActionEvents(db, { actionId: action?.id ?? "" }).map((event) => event.event_type)).toEqual([
        "candidate",
        "gate_decision",
        "execution_started",
        "execution_result"
      ]);
      expect(audit).toMatchObject({
        conversation_id: "conversation-mcp-tool",
        event_type: "tool_call_audit",
        project_id: project.id
      });
      expect(JSON.parse(audit?.payload_json ?? "{}")).toMatchObject({
        provider_id: "mcp-docs",
        status: "failed",
        tool: "search"
      });
      expect(audit?.payload_json).not.toContain("secret-token-value");
    } finally {
      db.close();
    }
  });

test("fails closed when configured MCP resources have no executable transport", async () => {
    const { db, project } = await openFixture();
    Bun.env.XUANWU_MCP_REGISTRY_JSON = JSON.stringify({ servers: [docsServer()] });
    try {
      const actions = createPiRunnerActions(db, {
        authorization: {
          allowed_mcp_capabilities: ["docs:resource:runbook"],
          authorizedActions: [{ action_type: "mcp.resource.read", project_id: project.id }],
          mode: "delegated",
          scope: { project_id: project.id }
        },
        project
      });

      const result = await actions.readMcpResource({ capability_id: "docs:resource:runbook" });

      expect(result).toMatchObject({
        error: { code: "mcp_server_unavailable", message: "MCP server has no executable transport" },
        status: "failed"
      });
      expect(listPiActionEvents(db, { eventType: "tool_call_audit" }).map((event) =>
        JSON.parse(event.payload_json)
      )).toEqual([expect.objectContaining({ provider_id: "mcp-docs", status: "failed", tool: "resource:runbook" })]);
    } finally {
      db.close();
    }
  });

test("calls real stdio MCP tools and resources through gate and audit", async () => {
    const { db, project, root } = await openFixture();
    const serverScript = await writeRealMcpServer(root);
    Bun.env.XUANWU_MCP_REGISTRY_JSON = JSON.stringify({
      servers: [realMcpServer(serverScript)]
    });
    try {
      const actions = createPiRunnerActions(db, {
        authorization: {
          allowed_mcp_capabilities: ["docs:tool:search", "docs:resource:runbook"],
          authorizedActions: [{ action_type: "mcp.tool.call", project_id: project.id }],
          mode: "delegated",
          scope: { project_id: project.id }
        },
        conversationID: "conversation-real-mcp",
        project
      });
      const tools = createPiRunnerActionTools(actions);

      const tool = await runTool(tools, "mcp_tool_call", {
        capability_id: "docs:tool:search",
        input: { query: "deploy" }
      });
      const resource = await actions.readMcpResource({ capability_id: "docs:resource:runbook" });
      const audits = listPiActionEvents(db, { eventType: "tool_call_audit" })
        .map((event) => JSON.parse(event.payload_json) as Record<string, any>);

      expect(tool.details).toMatchObject({
        output: { items: ["real-runbook"], query: "deploy" },
        status: "succeeded"
      });
      expect(resource).toMatchObject({
        capability: { id: "docs:resource:runbook" },
        content: "real deploy safely"
      });
      expect(audits).toEqual(expect.arrayContaining([
        expect.objectContaining({ provider_id: "mcp-docs", status: "succeeded", tool: "search" }),
        expect.objectContaining({ provider_id: "mcp-docs", status: "succeeded", tool: "resource:runbook" })
      ]));
      expect(JSON.stringify(audits)).not.toContain("secret-token-value");
    } finally {
      db.close();
    }
  });
}
