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

export const tempRoots: string[] = [];

export const previousRegistry = Bun.env.XUANWU_MCP_REGISTRY_JSON;

export async function openFixture(): Promise<{ db: RunnerDatabase; project: Project; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-pi-mcp-tools-"));
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

export async function writeRealMcpServer(root: string): Promise<string> {
  const script = join(root, "fixture-mcp-server.mjs");
  await writeFile(script, REAL_MCP_SERVER_SCRIPT, "utf8");
  return script;
}

export function offlineServer() {
  return {
    id: "offline-docs",
    status: "unavailable",
    readiness: "auth_missing",
    resources: [
      { name: "guide", description: "Offline guide", content: "must not leak" }
    ]
  };
}

export function docsServer() {
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

export function realMcpServer(
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

export function missingMcpServer() {
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

export const REAL_MCP_SERVER_SCRIPT = `
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

export function toolNames(tools: ReturnType<typeof createPiRunnerActionTools>): string[] {
  return tools.map((tool) => tool.name);
}

export function toolByName(tools: ReturnType<typeof createPiRunnerActionTools>, name: string) {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

export async function runTool(tools: ReturnType<typeof createPiRunnerActionTools>, name: string, params: Record<string, unknown>) {
  return await toolByName(tools, name).execute("tool-call", params as never, undefined, undefined, {} as never) as { details: any };
}
