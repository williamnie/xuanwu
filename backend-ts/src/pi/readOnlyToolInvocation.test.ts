import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listPiActionEvents, listPiActions } from "../db/repositories/pi.ts";
import { invokeReadOnlyAssistantTool } from "./readOnlyToolInvocation.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("read-only assistant tool invocation", () => {
  test("invokes builtin read-only tools as ToolResult and audits without pending approval", async () => {
    const db = await openFixture();
    try {
      const result = await invokeReadOnlyAssistantTool({
        auditContext: { conversationID: "conv-builtin", source: "test" },
        db,
        input: {},
        providerID: "runner-builtin",
        toolName: "project_status"
      });

      expect(result).toMatchObject({ output: { items: [] }, status: "succeeded" });
      expect(listPiActions(db, { status: "pending" })).toEqual([]);
      expect(auditPayloads(db, "conv-builtin")[0]).toMatchObject({
        provider_id: "runner-builtin",
        source: "test",
        status: "succeeded",
        tool: "project_status"
      });
    } finally {
      db.close();
    }
  });

  test("invokes CLI read-only tools and denies non-read tools through the same service", async () => {
    const { db, dir } = await openCliFixture();
    try {
      const succeeded = await invokeReadOnlyAssistantTool({
        auditContext: { conversationID: "conv-cli", source: "test" },
        db,
        input: { payload: "hello" },
        manifestDirs: [dir],
        providerID: "fixture-cli",
        toolName: "echo"
      });
      const denied = await invokeReadOnlyAssistantTool({
        auditContext: { conversationID: "conv-cli-denied", source: "test" },
        db,
        input: { payload: "write" },
        manifestDirs: [dir],
        providerID: "fixture-cli",
        toolName: "mutate"
      });

      expect(succeeded).toMatchObject({ output: { payload: "hello" }, status: "succeeded" });
      expect(denied).toMatchObject({ error: { code: "permission_denied" }, status: "denied" });
      expect(listPiActions(db, { status: "pending" })).toEqual([]);
      expect(auditPayloads(db, "conv-cli")[0]).toMatchObject({
        provider_id: "fixture-cli",
        status: "succeeded",
        tool: "echo"
      });
      expect(auditPayloads(db, "conv-cli-denied")[0]).toMatchObject({
        provider_id: "fixture-cli",
        status: "denied",
        tool: "mutate"
      });
    } finally {
      db.close();
    }
  });

  test("invokes MCP success, failure, timeout, and stored aliases as ToolResult", async () => {
    const db = await openFixture();
    const env = { CODEX_RUNNER_MCP_REGISTRY_JSON: JSON.stringify({ servers: [docsServer()] }) };
    try {
      seedStoredMcpAlias(db);
      const succeeded = await invokeReadOnlyAssistantTool({
        auditContext: { conversationID: "conv-mcp", source: "test" },
        db,
        env,
        input: { query: "deploy" },
        providerID: "mcp-docs",
        toolName: "search"
      });
      const egressDenied = await invokeReadOnlyAssistantTool({
        auditContext: { conversationID: "conv-mcp-egress", source: "test" },
        db,
        env,
        input: { query: "deploy", token: "secret-token-value" },
        providerID: "mcp-docs",
        toolName: "search"
      });
      const failed = await invokeReadOnlyAssistantTool({
        auditContext: { conversationID: "conv-mcp-failed", source: "test" },
        db,
        env,
        providerID: "mcp-docs",
        toolName: "fails"
      });
      const timeout = await invokeReadOnlyAssistantTool({
        auditContext: { conversationID: "conv-mcp-timeout", source: "test" },
        db,
        env,
        providerID: "mcp-docs",
        timeoutMs: 5,
        toolName: "slow"
      });
      const stored = await invokeReadOnlyAssistantTool({
        auditContext: { conversationID: "conv-stored", source: "test" },
        db,
        env,
        input: { query: "deploy" },
        providerID: "stored-mcp",
        toolName: "stored_search"
      });

      expect(succeeded).toMatchObject({ output: { results: ["runbook"] }, status: "succeeded" });
      expect(egressDenied).toMatchObject({ error: { code: "sensitive_egress_denied" }, status: "denied" });
      expect(failed).toMatchObject({ error: { code: "fixture_failed" }, status: "failed" });
      expect(timeout).toMatchObject({ error: { code: "mcp_timeout" }, status: "timeout" });
      expect(stored).toMatchObject({ output: { results: ["runbook"] }, status: "succeeded" });
      expect(auditPayloads(db, "conv-mcp")[0]).toMatchObject({ provider_id: "mcp-docs", status: "succeeded", tool: "search" });
      expect(JSON.stringify(auditPayloads(db, "conv-mcp"))).not.toContain("secret-token-value");
      expect(JSON.stringify(auditPayloads(db, "conv-mcp-egress"))).not.toContain("secret-token-value");
      expect(auditPayloads(db, "conv-mcp-failed")[0]).toMatchObject({ provider_id: "mcp-docs", status: "failed", tool: "fails" });
      expect(auditPayloads(db, "conv-mcp-timeout")[0]).toMatchObject({ provider_id: "mcp-docs", status: "timeout", tool: "slow" });
      expect(auditPayloads(db, "conv-stored")[0]).toMatchObject({ provider_id: "stored-mcp", status: "succeeded", tool: "stored_search" });
    } finally {
      db.close();
    }
  });
});

async function openFixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-read-only-tools-"));
  tempRoots.push(root);
  return await openDatabase({ stateDir: join(root, "state") });
}

async function openCliFixture(): Promise<{ db: RunnerDatabase; dir: string }> {
  const db = await openFixture();
  const root = await mkdtemp(join(tmpdir(), "codex-runner-read-only-cli-"));
  tempRoots.push(root);
  const script = join(root, "fixture.mjs");
  await mkdir(root, { recursive: true });
  await writeFile(script, CLI_SCRIPT, "utf8");
  await writeFile(join(root, "fixture.json"), JSON.stringify(cliManifest(script), null, 2), "utf8");
  return { db, dir: root };
}

const CLI_SCRIPT = `
const mode = process.argv[2];
if (mode === "echo") console.log(JSON.stringify({ payload: process.argv[3] }));
else console.log(JSON.stringify({ ok: true }));
`;

function cliManifest(script: string): Record<string, unknown> {
  return {
    commands: [cliCommand(script, "echo", "read"), cliCommand(script, "mutate", "write")],
    health: {
      command: { args: [script, "health"], executable: process.execPath },
      exit_codes: { success: [0] },
      stdout: { mode: "json" }
    },
    id: "fixture-cli",
    kind: "cli",
    manifest_version: "pi-cli-connector.v0",
    name: "Fixture CLI"
  };
}

function cliCommand(script: string, name: string, permission: "read" | "write"): Record<string, unknown> {
  return {
    command: { args: [script, "echo", "{{input.payload}}"], executable: process.execPath },
    description: `${name} a payload.`,
    exit_codes: { success: [0], usage_error: [64] },
    input_schema: { properties: { payload: { type: "string" } }, required: ["payload"], type: "object" },
    name,
    output_schema: { properties: { payload: { type: "string" } }, type: "object" },
    permission,
    stdout: { mode: "json" }
  };
}

function docsServer(): Record<string, unknown> {
  return {
    id: "docs",
    readiness: "ready",
    status: "enabled",
    tools: [
      { name: "search", output: { results: ["runbook"] }, permission: "read", risk_level: "low" },
      { invocation: { error: { code: "fixture_failed", message: "fixture MCP failure" } }, name: "fails", permission: "read", risk_level: "low" },
      { invocation: { delay_ms: 50, output: { ok: true } }, name: "slow", permission: "read", risk_level: "low" }
    ]
  };
}

function seedStoredMcpAlias(db: RunnerDatabase): void {
  const now = "2026-07-06T00:00:00Z";
  db.sqlite.run(
    `insert into assistant_tool_providers
      (id, kind, name, description, status, audit_json, metadata_json, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["stored-mcp", "mcp", "Stored MCP", "Stored MCP alias provider.", "enabled", "{\"redact\":[]}", "{\"connector\":\"mcp\"}", now, now]
  );
  db.sqlite.run(
    `insert into assistant_tools
      (provider_id, name, description, input_schema_json, output_schema_json, permission, audit_json, metadata_json, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "stored-mcp",
      "stored_search",
      "Stored read-only MCP search alias.",
      "{\"type\":\"object\"}",
      "{\"type\":\"object\"}",
      "read",
      "{\"redact\":[]}",
      "{\"capability_id\":\"docs:tool:search\",\"connector\":\"mcp\"}",
      now,
      now
    ]
  );
}

function auditPayloads(db: RunnerDatabase, conversationId: string): Array<Record<string, any>> {
  return listPiActionEvents(db, { conversationId })
    .filter((event) => event.event_type === "tool_call_audit")
    .map((event) => JSON.parse(event.payload_json) as Record<string, any>);
}
