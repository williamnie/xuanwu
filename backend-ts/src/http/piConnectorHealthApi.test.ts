import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig } from "../config/env.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const FIXTURE_TOKEN = "FIXTURE_CONNECTOR_TOKEN";
const tempRoots: string[] = [];

afterEach(async () => {
  delete process.env[FIXTURE_TOKEN];
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI connector health API", () => {
  test("reports configured CLI connector health without leaking secret output", async () => {
    const { db, dir } = await openFixtureRuntime();
    process.env[FIXTURE_TOKEN] = "super-secret-token";
    try {
      const config = buildConfig({ cliConnectorDirs: [dir] });
      const router = createDefaultRouter({ config, database: db });

      const response = await router.handle(new Request(`${BASE_URL}/api/pi/connectors`));
      const text = await response.text();
      const body = JSON.parse(text) as ConnectorHealthBody;

      expect(response.status).toBe(200);
      expect(body.connectors).toEqual(expect.arrayContaining([
        expect.objectContaining({
          enabled: true,
          id: "fixture-cli-health",
          kind: "cli",
          status: "configured",
          health: expect.objectContaining({ checked: true, ok: true, status: "succeeded" }),
          summary: expect.objectContaining({ configured: true, state: "configured" })
        })
      ]));
      expect(text).toContain(FIXTURE_TOKEN);
      expect(text).not.toContain("super-secret-token");
    } finally {
      db.close();
    }
  });

  test("reports missing CLI connector env as disabled instead of crashing", async () => {
    const { db, dir } = await openFixtureRuntime();
    try {
      const config = buildConfig({ cliConnectorDirs: [dir] });
      const router = createDefaultRouter({ config, database: db });

      const response = await router.handle(new Request(`${BASE_URL}/api/pi/connectors`));
      const body = await response.json() as ConnectorHealthBody;
      const connector = body.connectors.find((item) => item.id === "fixture-cli-health");

      expect(response.status).toBe(200);
      expect(connector).toMatchObject({
        enabled: false,
        kind: "cli",
        missing_required: [FIXTURE_TOKEN],
        status: "disabled",
        health: { checked: false, ok: false, status: "skipped" },
        summary: expect.objectContaining({ configured: false, state: "disabled" })
      });
    } finally {
      db.close();
    }
  });
});

async function openFixtureRuntime(): Promise<{ db: RunnerDatabase; dir: string }> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-connectors-"));
  tempRoots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  const dir = join(root, "connectors");
  await Bun.$`mkdir -p ${dir}`;
  const script = join(dir, "fixture-health.mjs");
  await writeFile(script, CLI_SCRIPT, { mode: 0o755 });
  await writeFile(join(dir, "fixture.json"), JSON.stringify(cliManifest(script), null, 2));
  return { db, dir };
}

const CLI_SCRIPT = `
if (process.argv[2] === "health") {
  console.log(JSON.stringify({ ok: true, token: process.env.${FIXTURE_TOKEN} || "" }));
} else {
  console.log(JSON.stringify({ ok: true }));
}
`;

function cliManifest(script: string): Record<string, unknown> {
  return {
    manifest_version: "pi-cli-connector.v0",
    id: "fixture-cli-health",
    name: "Fixture CLI Health",
    kind: "cli",
    auth: { type: "env", env: [FIXTURE_TOKEN] },
    env: [{ name: FIXTURE_TOKEN, required: true, secret: true }],
    timeout: { default_ms: 1000, max_ms: 5000 },
    health: {
      command: { executable: process.execPath, args: [script, "health"] },
      stdout: { mode: "json" },
      exit_codes: { success: [0], auth_required: [20], usage_error: [64] }
    },
    commands: [{
      name: "sync_items",
      description: "Fetch fixture items.",
      permission: "read",
      command: { executable: process.execPath, args: [script, "sync"] },
      input_schema: { type: "object" },
      output_schema: { type: "object" },
      stdout: { mode: "json" },
      exit_codes: { success: [0] }
    }]
  };
}

type ConnectorHealthBody = {
  connectors: Array<{
    enabled?: boolean;
    health?: Record<string, unknown>;
    id: string;
    kind?: string;
    missing_required?: string[];
    status?: string;
    summary?: Record<string, unknown>;
  }>;
};
