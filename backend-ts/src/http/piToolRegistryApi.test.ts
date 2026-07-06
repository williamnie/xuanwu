import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig } from "../config/env.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listPiActionEvents } from "../db/repositories/pi.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI tool registry read API", () => {
  test("returns builtin providers and tool metadata when stored registry is empty", async () => {
    const db = await openFixture();
    try {
      const router = createDefaultRouter({ database: db });
      const providers = await router.handle(new Request(`${BASE_URL}/api/pi/tool-providers`));
      const tools = await router.handle(new Request(`${BASE_URL}/api/pi/tools`));
      const detail = await router.handle(new Request(`${BASE_URL}/api/pi/tools/runner-builtin%3Aissue_read`));
      const post = await router.handle(new Request(`${BASE_URL}/api/pi/tools/runner-builtin%3Aissue_read`, { method: "POST" }));

      expect(providers.status).toBe(200);
      await expect(providers.json()).resolves.toMatchObject({
        providers: [expect.objectContaining({ id: "runner-builtin", kind: "builtin" })]
      });

      expect(tools.status).toBe(200);
      const toolBody = await tools.json() as Record<string, any>;
      expect(toolBody.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({
          description: expect.any(String),
          input_schema: expect.objectContaining({ type: "object" }),
          name: "issue_read",
          permission: "read",
          permission_summary: expect.objectContaining({ level: "read" }),
          provider: expect.objectContaining({ id: "runner-builtin" }),
          provider_id: "runner-builtin"
        })
      ]));

      expect(detail.status).toBe(200);
      await expect(detail.json()).resolves.toMatchObject({
        tool: expect.objectContaining({ name: "issue_read", provider_id: "runner-builtin" })
      });
      expect(post.status).toBe(405);
    } finally {
      db.close();
    }
  });

  test("loads fixture CLI connector tools into the registry API", async () => {
    const db = await openFixture();
    const dir = await cliConnectorFixtureDir();
    try {
      const config = buildConfig({ cliConnectorDirs: [dir] });
      const router = createDefaultRouter({ config, database: db });
      const response = await router.handle(new Request(`${BASE_URL}/api/pi/tools`));

      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, any>;
      expect(body.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "echo",
          permission: "read",
          provider: expect.objectContaining({ id: "fixture-cli", kind: "cli" }),
          provider_id: "fixture-cli"
        })
      ]));
    } finally {
      db.close();
    }
  });

  test("calls CLI connector tools and records standard audit", async () => {
    const db = await openFixture();
    const dir = await cliConnectorFixtureDir();
    try {
      const config = buildConfig({ cliConnectorDirs: [dir] });
      const router = createDefaultRouter({ config, database: db });
      const response = await router.handle(new Request(`${BASE_URL}/api/pi/tools/fixture-cli%3Aecho/call`, {
        body: JSON.stringify({
          audit_context: { conversation_id: "conv-cli", source: "test" },
          input: { payload: "hello" },
          permission: "read"
        }),
        method: "POST"
      }));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        result: { output: { payload: "hello" }, status: "succeeded" }
      });
      const audit = listPiActionEvents(db, { conversationId: "conv-cli" })
        .find((event) => event.event_type === "tool_call_audit");
      expect(JSON.parse(audit?.payload_json ?? "{}")).toMatchObject({
        provider_id: "fixture-cli",
        source: "test",
        status: "succeeded",
        tool: "echo"
      });
    } finally {
      db.close();
    }
  });

  test("denies CLI connector write tools without explicit permission and audits denial", async () => {
    const db = await openFixture();
    const dir = await cliConnectorFixtureDir();
    try {
      const config = buildConfig({ cliConnectorDirs: [dir] });
      const router = createDefaultRouter({ config, database: db });
      const response = await router.handle(new Request(`${BASE_URL}/api/pi/tools/fixture-cli%3Amutate/call`, {
        body: JSON.stringify({
          audit_context: { conversation_id: "conv-cli-denied", source: "test" },
          input: { payload: "do-write" }
        }),
        method: "POST"
      }));

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        result: { error: { code: "permission_denied" }, status: "denied" }
      });
      const audit = listPiActionEvents(db, { conversationId: "conv-cli-denied" })
        .find((event) => event.event_type === "tool_call_audit");
      expect(JSON.parse(audit?.payload_json ?? "{}")).toMatchObject({
        provider_id: "fixture-cli",
        status: "denied",
        tool: "mutate"
      });
    } finally {
      db.close();
    }
  });

  test("redacts secret-looking values from stored registry metadata", async () => {
    const db = await openFixture();
    try {
      seedSecretFixture(db);
      const router = createDefaultRouter({ database: db });
      const response = await router.handle(new Request(`${BASE_URL}/api/pi/tools/fixture-http%3Asecret_probe`));

      expect(response.status).toBe(200);
      const text = JSON.stringify(await response.json());
      expect(text).toContain("[redacted]");
      expect(text).not.toContain("super-secret");
      expect(text).not.toContain("CODEX_RUNNER_AUTH_TOKEN=abc");
    } finally {
      db.close();
    }
  });
});

async function openFixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-tool-registry-api-"));
  tempRoots.push(root);
  return await openDatabase({ stateDir: join(root, "state") });
}

async function cliConnectorFixtureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codex-runner-cli-api-"));
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
      JSON.stringify({ env: "CODEX_RUNNER_AUTH_TOKEN=abc", token: "super-secret" }),
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
