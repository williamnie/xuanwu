import { afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";



export function createTestFixture() {
  const BASE_URL = "http://127.0.0.1:3008";

  const previousMcpRegistry = Bun.env.XUANWU_MCP_REGISTRY_JSON;

  const tempRoots: string[] = [];

  afterEach(async () => {
    if (previousMcpRegistry === undefined) delete Bun.env.XUANWU_MCP_REGISTRY_JSON;
    else Bun.env.XUANWU_MCP_REGISTRY_JSON = previousMcpRegistry;
    while (tempRoots.length > 0) {
      const path = tempRoots.pop();
      if (path) await rm(path, { recursive: true, force: true });
    }
  });

  async function openFixture(): Promise<RunnerDatabase> {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-tool-registry-api-"));
    tempRoots.push(root);
    return await openDatabase({ stateDir: join(root, "state") });
  }

  async function cliConnectorFixtureDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "xuanwu-cli-api-"));
    tempRoots.push(dir);
    const script = join(dir, "fixture.mjs");
    await writeFile(script, CLI_SCRIPT, "utf8");
    await writeFile(join(dir, "fixture.json"), JSON.stringify(cliManifest(script), null, 2), "utf8");
    await writeFile(join(dir, "broken.json"), "{bad json", "utf8");
    return dir;
  }

  const CLI_SCRIPT = `
const mode = process.argv[2];
if (mode === "echo") {
  console.log(JSON.stringify({ payload: process.argv[3] }));
} else {
  console.log(JSON.stringify({ ok: true }));
}
`;

  function cliManifest(script: string): Record<string, unknown> {
    return {
      manifest_version: "pi-cli-connector.v0",
      id: "fixture-cli",
      name: "Fixture CLI",
      kind: "cli",
      timeout: { default_ms: 2000, max_ms: 5000 },
      health: {
        command: { executable: process.execPath, args: [script, "health"] },
        stdout: { mode: "json" },
        exit_codes: { success: [0] }
      },
      commands: [cliCommand(script, "echo", "read"), cliCommand(script, "mutate", "write")]
    };
  }

  function cliCommand(script: string, name: string, permission: "read" | "write"): Record<string, unknown> {
    return {
      name,
      description: `${name} a payload.`,
      permission,
      command: { executable: process.execPath, args: [script, "echo", "{{input.payload}}"] },
      input_schema: { type: "object", additionalProperties: false, properties: { payload: { type: "string" } }, required: ["payload"] },
      output_schema: { type: "object", additionalProperties: false, properties: { payload: { type: "string" } }, required: ["payload"] },
      stdout: { mode: "json" },
      exit_codes: { success: [0], usage_error: [64] }
    };
  }

  function seedSecretFixture(db: RunnerDatabase): void {
    const now = "2026-07-06T00:00:00Z";
    db.sqlite.run(
      `insert into assistant_tool_providers
      (id, kind, name, description, status, audit_json, metadata_json, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "fixture-http",
        "http",
        "Fixture HTTP",
        "Secret fixture provider.",
        "enabled",
        JSON.stringify({ redact: ["headers.authorization"] }),
        JSON.stringify({ env: "XUANWU_AUTH_TOKEN=abc", token: "super-secret" }),
        now,
        now
      ]
    );
    db.sqlite.run(
      `insert into assistant_tools
      (provider_id, name, description, input_schema_json, output_schema_json, permission, audit_json, metadata_json, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "fixture-http",
        "secret_probe",
        "Probe a secret-backed endpoint.",
        JSON.stringify({ properties: { token: { default: "super-secret", type: "string" } }, type: "object" }),
        JSON.stringify({ type: "object" }),
        "read",
        JSON.stringify({ redact: ["input.token"] }),
        JSON.stringify({ api_key: "super-secret" }),
        now,
        now
      ]
    );
  }

  function docsMcpServer(): Record<string, unknown> {
    return {
      description: "Documentation MCP server.",
      id: "docs",
      metadata: { transport: "stdio" },
      name: "Docs MCP",
      readiness: "ready",
      status: "enabled",
      tools: [{
        description: "Search documentation.",
        input_schema: {
          additionalProperties: false,
          properties: { query: { type: "string" } },
          required: ["query"],
          type: "object"
        },
        name: "search",
        output_schema: { properties: { results: { type: "array" } }, type: "object" },
        permission: "read",
        risk_level: "low"
      }]
    };
  }

  function failedMcpServer(): Record<string, unknown> {
    return {
      id: "missing-docs",
      readiness: "spawn_failed",
      status: "failed",
      tools: [{ description: "Offline search.", name: "search", permission: "read" }]
    };
  }
  return { BASE_URL, previousMcpRegistry, tempRoots, openFixture, cliConnectorFixtureDir, CLI_SCRIPT, cliManifest, cliCommand, seedSecretFixture, docsMcpServer, failedMcpServer };
}
export type TestFixture = ReturnType<typeof createTestFixture>;
