import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

  test("executes read-only MCP resources only when delegated allowlist covers them", async () => {
    const { db, project } = await openFixture();
    Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON = JSON.stringify({ servers: [docsServer()] });
    try {
      const actions = createPiRunnerActions(db, {
        authorization: {
          allowedMcpCapabilities: ["docs:resource:runbook"],
          authorizedActions: [{ action_type: "mcp.resource.read", project_id: project.id }],
          mode: "delegated"
        },
        project
      });

      const allowed = actions.readMcpResource({ capability_id: "docs:resource:runbook" }) as { decision: string; status: string };
      const denied = actions.readMcpResource({ capability_id: "docs:resource:secret" }) as { decision: string; status: string };
      const allowedAction = listPiActions(db).find((action) => action.action_type === "mcp.resource.read" && action.status === "completed");

      expect(allowed).toMatchObject({ capability: { id: "docs:resource:runbook" }, content: "deploy safely" });
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
          mode: "delegated"
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

  test("keeps high-risk MCP resources and tool calls behind the action gate by default", async () => {
    const { db, project } = await openFixture();
    Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON = JSON.stringify({ servers: [docsServer()] });
    try {
      const actions = createPiRunnerActions(db, { project });

      const resource = actions.readMcpResource({ capability_id: "docs:resource:secret" }) as { decision: string; risk_level: string; status: string };
      const pending = actions.callMcpTool({
        args: { id: "runbook" },
        capability_id: "docs:tool:delete_doc",
        rationale: "cleanup obsolete docs"
      }) as { decision: string; risk_level: string; status: string };

      expect(resource).toMatchObject({ decision: "ask", risk_level: "high", status: "pending" });
      expect(pending).toMatchObject({ decision: "ask", risk_level: "high", status: "pending" });
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

function docsServer() {
  return {
    id: "docs",
    status: "enabled",
    readiness: "ready",
    permissions: ["read"],
    risk_level: "low",
    resources: [
      { name: "runbook", description: "Deployment runbook and operations guide", content: "deploy safely" },
      { name: "secret", description: "Sensitive vault record", permission: "admin", risk_level: "high" }
    ],
    tools: [
      { name: "search", description: "Search documentation", permission: "read", risk_level: "low" },
      { name: "delete_doc", description: "Delete documentation", permission: "write", risk_level: "high" }
    ]
  };
}

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
