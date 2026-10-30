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

export function registerNormalizesRealMCPTransportErrorsTimeouts() {
test("normalizes real MCP transport errors, timeouts, and schema mismatches", async () => {
    const { db, project, root } = await openFixture();
    const serverScript = await writeRealMcpServer(root);
    Bun.env.XUANWU_MCP_REGISTRY_JSON = JSON.stringify({
      servers: [
        realMcpServer(serverScript, { id: "tool-error", mode: "tool-error" }),
        realMcpServer(serverScript, { id: "tool-slow", mode: "slow", toolTimeoutMs: 5 }),
        missingMcpServer(),
        realMcpServer(serverScript, { id: "resource-bad", mode: "bad-schema" }),
        realMcpServer(serverScript, { id: "resource-slow", mode: "slow", resourceTimeoutMs: 5 })
      ]
    });
    try {
      const actions = createPiRunnerActions(db, {
        authorization: {
          allowed_mcp_capabilities: [
            "tool-error:tool:search",
            "tool-slow:tool:search",
            "spawn-missing:tool:search",
            "resource-bad:resource:runbook",
            "resource-slow:resource:runbook"
          ],
          authorizedActions: [{ action_type: "mcp.tool.call", project_id: project.id }],
          mode: "delegated",
          scope: { project_id: project.id }
        },
        conversationID: "conversation-real-mcp-failure",
        project
      });
      const tools = createPiRunnerActionTools(actions);

      const toolError = await runTool(tools, "mcp_tool_call", { capability_id: "tool-error:tool:search" });
      const toolTimeout = await runTool(tools, "mcp_tool_call", { capability_id: "tool-slow:tool:search" });
      const spawnFailure = await runTool(tools, "mcp_tool_call", { capability_id: "spawn-missing:tool:search" });
      const resourceSchema = await actions.readMcpResource({ capability_id: "resource-bad:resource:runbook" });
      const resourceTimeout = await actions.readMcpResource({ capability_id: "resource-slow:resource:runbook" });
      const audits = listPiActionEvents(db, { eventType: "tool_call_audit" })
        .map((event) => JSON.parse(event.payload_json) as Record<string, any>);

      expect(toolError.details).toMatchObject({
        error: { code: "mcp_tool_error", message: "fixture MCP tool failed" },
        status: "failed"
      });
      expect(toolTimeout.details).toMatchObject({
        error: { code: "mcp_timeout" },
        status: "timeout"
      });
      expect(spawnFailure.details).toMatchObject({
        error: { code: "mcp_spawn_error" },
        status: "failed"
      });
      expect(resourceSchema).toMatchObject({
        error: { code: "mcp_schema_mismatch" },
        status: "failed"
      });
      expect(resourceTimeout).toMatchObject({
        error: { code: "mcp_timeout" },
        status: "timeout"
      });
      expect(audits).toEqual(expect.arrayContaining([
        expect.objectContaining({ provider_id: "mcp-tool-error", status: "failed", tool: "search" }),
        expect.objectContaining({ provider_id: "mcp-tool-slow", status: "timeout", tool: "search" }),
        expect.objectContaining({ provider_id: "mcp-spawn-missing", status: "failed", tool: "search" }),
        expect.objectContaining({ provider_id: "mcp-resource-bad", status: "failed", tool: "resource:runbook" }),
        expect.objectContaining({ provider_id: "mcp-resource-slow", status: "timeout", tool: "resource:runbook" })
      ]));
    } finally {
      db.close();
    }
  });

test("executes read-only MCP resources only when delegated allowlist covers them", async () => {
    const { db, project, root } = await openFixture();
    const serverScript = await writeRealMcpServer(root);
    Bun.env.XUANWU_MCP_REGISTRY_JSON = JSON.stringify({ servers: [realMcpServer(serverScript)] });
    try {
      const actions = createPiRunnerActions(db, {
        authorization: {
          allowedMcpCapabilities: ["docs:resource:runbook"],
          authorizedActions: [{ action_type: "mcp.resource.read", project_id: project.id }],
          mode: "delegated",
          scope: { project_id: project.id }
        },
        project
      });

      const allowed = await actions.readMcpResource({ capability_id: "docs:resource:runbook" }) as { decision: string; status: string };
      const denied = await actions.readMcpResource({ capability_id: "docs:resource:secret" }) as { decision: string; status: string };
      const allowedAction = listPiActions(db).find((action) => action.action_type === "mcp.resource.read" && action.status === "completed");

      expect(allowed).toMatchObject({ capability: { id: "docs:resource:runbook" }, content: "real deploy safely" });
      expect(denied).toMatchObject({ decision: "deny", status: "denied" });
      expect(allowedAction).toMatchObject({ project_id: project.id, source: "pi_mcp_tool" });
      expect(listPiActionEvents(db, { actionId: allowedAction?.id ?? "" }).map((event) => event.event_type)).toEqual([
        "candidate",
        "gate_decision",
        "execution_started",
        "execution_result"
      ]);
    } finally {
      db.close();
    }
  });

test("stores recommended MCP requirements on issue proposals", async () => {
    const { db, project } = await openFixture();
    Bun.env.XUANWU_MCP_REGISTRY_JSON = JSON.stringify({ servers: [docsServer()] });
    try {
      const actions = createPiRunnerActions(db, {
        authorization: {
          allowedMcpCapabilities: ["docs:resource:runbook"],
          authorizedActions: [{ action_type: "issue.create", project_id: project.id }],
          mode: "delegated",
          scope: { project_id: project.id }
        },
        project
      });

      const created = actions.createIssueProposal({
        description: "Need runbook context",
        project_id: project.id,
        recommended_mcp_capabilities: ["docs:resource:runbook"],
        title: "Use MCP runbook"
      }) as { status: string };
      const denied = actions.createIssueProposal({
        description: "Needs secret MCP context",
        project_id: project.id,
        recommended_mcp_capabilities: ["docs:resource:secret"],
        title: "Denied MCP"
      }) as { decision: string; status: string };

      expect(created).toMatchObject({ status: "completed" });
      expect(denied).toMatchObject({ decision: "deny", status: "denied" });
      expect(JSON.parse(getIssue(db, 1)?.recommended_mcp_capabilities ?? "[]")).toEqual(["docs:resource:runbook"]);
    } finally {
      db.close();
    }
  });

test("denies high-risk or offline MCP resources and records audit", async () => {
    const { db, project } = await openFixture();
    Bun.env.XUANWU_MCP_REGISTRY_JSON = JSON.stringify({ servers: [docsServer(), offlineServer()] });
    try {
      const actions = createPiRunnerActions(db, { project });

      const resource = await actions.readMcpResource({ capability_id: "docs:resource:secret" }) as { decision: string; risk_level: string; status: string };
      const offlineList = actions.listMcpResources({ server_id: "offline-docs" }) as { decision: string; status: string };
      const offlineRead = await actions.readMcpResource({ capability_id: "offline-docs:resource:guide" }) as { decision: string; status: string };
      const deniedActions = listPiActions(db, { status: "denied" });

      expect(resource).toMatchObject({ decision: "deny", risk_level: "high", status: "denied" });
      expect(offlineList).toMatchObject({ decision: "deny", status: "denied" });
      expect(offlineRead).toMatchObject({ decision: "deny", status: "denied" });
      expect(deniedActions.map((item) => item.action_type).sort()).toEqual([
        "mcp.resource.list",
        "mcp.resource.read",
        "mcp.resource.read"
      ]);
      expect(listPiActionEvents(db, { actionId: deniedActions[0]?.id ?? "" }).map((event) => event.event_type)).toEqual([
        "candidate",
        "gate_decision"
      ]);
    } finally {
      db.close();
    }
  });

test("routes non-low MCP resources through gate as confirmation instead of silent deny", async () => {
    const { db, project } = await openFixture();
    Bun.env.XUANWU_MCP_REGISTRY_JSON = JSON.stringify({ servers: [docsServer()] });
    try {
      const actions = createPiRunnerActions(db, { project });
      const result = await actions.readMcpResource({ capability_id: "docs:resource:internal" }) as {
        decision: string;
        risk_level: string;
        status: string;
      };
      const action = listPiActions(db).find((item) => item.action_type === "mcp.resource.read");

      expect(result).toMatchObject({ decision: "ask", risk_level: "medium", status: "pending" });
      expect(action).toMatchObject({
        action_type: "mcp.resource.read",
        gate_decision: "ask",
        requires_confirmation: 1,
        risk_level: "medium",
        status: "pending"
      });
      expect(listPiActionEvents(db, { actionId: action?.id ?? "" }).map((event) => event.event_type)).toEqual([
        "candidate",
        "gate_decision",
        "pending_approval"
      ]);
    } finally {
      db.close();
    }
  });
}
