import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listPiActionEvents, listPiActions } from "../db/repositories/pi.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { getProject, type Project } from "../db/repositories/projects.ts";
import { createPiRunnerActions } from "./runnerActions.ts";
import { createPiRunnerActionTools } from "./runnerActionTools.ts";

const tempRoots: string[] = [];
const previousRegistry = Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON;

afterEach(async () => {
  if (previousRegistry === undefined) delete Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON;
  else Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON = previousRegistry;
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI MCP registry and envelope tools", () => {
  test("exposes MCP registry and recommendation tools to PI", async () => {
    const { db, project } = await openFixture();
    Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON = JSON.stringify({ servers: [docsServer()] });
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
    Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON = JSON.stringify({ servers: [docsServer()] });
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
    Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON = JSON.stringify({ servers: [docsServer()] });
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

      const result = actions.readMcpResource({ capability_id: "docs:resource:runbook" });

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
    Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON = JSON.stringify({
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
      const resource = actions.readMcpResource({ capability_id: "docs:resource:runbook" });
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

  test("normalizes real MCP transport errors, timeouts, and schema mismatches", async () => {
    const { db, project, root } = await openFixture();
    const serverScript = await writeRealMcpServer(root);
    Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON = JSON.stringify({
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
      const resourceSchema = actions.readMcpResource({ capability_id: "resource-bad:resource:runbook" });
      const resourceTimeout = actions.readMcpResource({ capability_id: "resource-slow:resource:runbook" });
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
    Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON = JSON.stringify({ servers: [realMcpServer(serverScript)] });
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

      const allowed = actions.readMcpResource({ capability_id: "docs:resource:runbook" }) as { decision: string; status: string };
      const denied = actions.readMcpResource({ capability_id: "docs:resource:secret" }) as { decision: string; status: string };
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
    Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON = JSON.stringify({ servers: [docsServer()] });
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
        recommended_mcp_capabilities: ["docs:resource:runbook"],
        title: "Use MCP runbook"
      }) as { status: string };
      const denied = actions.createIssueProposal({
        description: "Needs secret MCP context",
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
    Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON = JSON.stringify({ servers: [docsServer(), offlineServer()] });
    try {
      const actions = createPiRunnerActions(db, { project });

      const resource = actions.readMcpResource({ capability_id: "docs:resource:secret" }) as { decision: string; risk_level: string; status: string };
      const offlineList = actions.listMcpResources({ server_id: "offline-docs" }) as { decision: string; status: string };
      const offlineRead = actions.readMcpResource({ capability_id: "offline-docs:resource:guide" }) as { decision: string; status: string };
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
    Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON = JSON.stringify({ servers: [docsServer()] });
    try {
      const actions = createPiRunnerActions(db, { project });
      const result = actions.readMcpResource({ capability_id: "docs:resource:internal" }) as {
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

  test("executes delegated read-permission MCP resources when allowlist covers them", async () => {
    const { db, project, root } = await openFixture();
    const serverScript = await writeRealMcpServer(root);
    Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON = JSON.stringify({ servers: [realMcpServer(serverScript)] });
    try {
      const actions = createPiRunnerActions(db, {
        authorization: {
          allowed_mcp_capabilities: ["docs:resource:internal"],
          authorizedActions: [{ action_type: "mcp.resource.read", project_id: project.id }],
          mode: "delegated",
          scope: { project_id: project.id }
        },
        project
      });
      const result = actions.readMcpResource({ capability_id: "docs:resource:internal" }) as {
        content: string;
        decision?: string;
        status?: string;
      };
      const action = listPiActions(db).find((item) => item.action_type === "mcp.resource.read");

      expect(result).toMatchObject({ content: "real deploy safely" });
      expect(action).toMatchObject({
        action_type: "mcp.resource.read",
        gate_decision: "execute",
        requires_confirmation: 1,
        risk_level: "medium",
        status: "completed"
      });
      expect(listPiActionEvents(db, { actionId: action?.id ?? "" }).map((event) => event.event_type)).toEqual([
        "candidate",
        "gate_decision",
        "execution_started",
        "execution_result"
      ]);
    } finally {
      db.close();
    }
  });
});

async function openFixture(): Promise<{ db: RunnerDatabase; project: Project; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-mcp-tools-"));
  tempRoots.push(root);
  const cwd = join(root, "project");
  await mkdir(cwd, { recursive: true });
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    ["demo", "Demo", cwd, 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const project = getProject(db, "demo");
  if (!project) throw new Error("missing project");
  return { db, project, root };
}

async function writeRealMcpServer(root: string): Promise<string> {
  const script = join(root, "fixture-mcp-server.mjs");
  await writeFile(script, REAL_MCP_SERVER_SCRIPT, "utf8");
  return script;
}

function offlineServer() {
  return {
    id: "offline-docs",
    status: "unavailable",
    readiness: "auth_missing",
    resources: [
      { name: "guide", description: "Offline guide", content: "must not leak" }
    ]
  };
}

function docsServer() {
  return {
    id: "docs",
    status: "enabled",
    readiness: "ready",
    permissions: ["read"],
    risk_level: "low",
    resources: [
      { name: "runbook", description: "Deployment runbook and operations guide", content: "deploy safely" },
      { name: "internal", description: "Internal deployment note", content: "needs approval", risk_level: "medium" },
      { name: "secret", description: "Sensitive vault record", permission: "admin", risk_level: "high" }
    ],
    tools: [
      {
        name: "search",
        description: "Search documentation",
        permission: "read",
        risk_level: "low",
        output: { items: ["runbook"], ok: true },
        timeout_ms: 50
      },
      { name: "delete_doc", description: "Delete documentation", permission: "write", risk_level: "high" }
    ]
  };
}

function realMcpServer(
  script: string,
  options: { id?: string; mode?: string; resourceTimeoutMs?: number; toolTimeoutMs?: number } = {}
) {
  const id = options.id ?? "docs";
  return {
    id,
    readiness: "ready",
    status: "enabled",
    transport: {
      args: [script, options.mode ?? "ok"],
      command: process.execPath,
      type: "stdio"
    },
    resources: [
      {
        name: "runbook",
        permission: "read",
        risk_level: "low",
        timeout_ms: options.resourceTimeoutMs ?? 500,
        uri: `mcp://${id}/runbook`
      },
      {
        name: "internal",
        permission: "read",
        risk_level: "medium",
        timeout_ms: options.resourceTimeoutMs ?? 500,
        uri: `mcp://${id}/internal`
      },
      {
        name: "secret",
        permission: "admin",
        risk_level: "high",
        timeout_ms: options.resourceTimeoutMs ?? 500,
        uri: `mcp://${id}/secret`
      }
    ],
    tools: [
      {
        name: "search",
        permission: "read",
        risk_level: "low",
        timeout_ms: options.toolTimeoutMs ?? 500
      }
    ]
  };
}

function missingMcpServer() {
  return {
    id: "spawn-missing",
    readiness: "ready",
    status: "enabled",
    transport: {
      args: [],
      command: "/definitely/missing/mcp-server",
      type: "stdio"
    },
    tools: [
      { name: "search", permission: "read", risk_level: "low", timeout_ms: 500 }
    ]
  };
}

const REAL_MCP_SERVER_SCRIPT = `
import { readFileSync } from "node:fs";

const mode = process.argv[2] || "ok";
const lines = readFileSync(0, "utf8").split(/\\r?\\n/).filter(Boolean);

for (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === "notifications/initialized") continue;
  if (message.method === "initialize") {
    send({
      id: message.id,
      jsonrpc: "2.0",
      result: {
        capabilities: { resources: {}, tools: {} },
        protocolVersion: "2024-11-05",
        serverInfo: { name: "fixture-mcp", version: "0.0.0" }
      }
    });
    continue;
  }
  if (mode === "slow") await new Promise((resolve) => setTimeout(resolve, 100));
  if (message.method === "tools/call") {
    if (mode === "tool-error") {
      send({ error: { code: -32000, message: "fixture MCP tool failed" }, id: message.id, jsonrpc: "2.0" });
    } else {
      const args = message.params?.arguments || {};
      send({
        id: message.id,
        jsonrpc: "2.0",
        result: {
          content: [{ text: JSON.stringify({ items: ["real-runbook"], query: args.query || "" }), type: "text" }]
        }
      });
    }
    continue;
  }
  if (message.method === "resources/read") {
    if (mode === "bad-schema") {
      send({ id: message.id, jsonrpc: "2.0", result: { content: [] } });
    } else {
      send({
        id: message.id,
        jsonrpc: "2.0",
        result: {
          contents: [{ mimeType: "text/plain", text: "real deploy safely", uri: message.params?.uri || "" }]
        }
      });
    }
    continue;
  }
  send({ error: { code: -32601, message: "method not found" }, id: message.id, jsonrpc: "2.0" });
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
`;

function toolNames(tools: ReturnType<typeof createPiRunnerActionTools>): string[] {
  return tools.map((tool) => tool.name);
}

function toolByName(tools: ReturnType<typeof createPiRunnerActionTools>, name: string) {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

async function runTool(tools: ReturnType<typeof createPiRunnerActionTools>, name: string, params: Record<string, unknown>) {
  return await toolByName(tools, name).execute("tool-call", params as never, undefined, undefined, {} as never) as { details: any };
}
