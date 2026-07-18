import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildConfig } from "../config/env.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createDefaultRouter } from "./server.ts";
import { createDatabaseSecretService } from "../security/secrets/service.ts";

const BASE_URL = "http://127.0.0.1:3008";
const FIXTURE_TOKEN = "FIXTURE_CONNECTOR_TOKEN";
const BROWSER_SNAPSHOT_ENV = "CODEX_RUNNER_BROWSER_SNAPSHOT_JSON";
const previousBrowserSnapshot = process.env[BROWSER_SNAPSHOT_ENV];
const tempRoots: string[] = [];

afterEach(async () => {
  delete process.env[FIXTURE_TOKEN];
  if (previousBrowserSnapshot === undefined) delete process.env[BROWSER_SNAPSHOT_ENV];
  else process.env[BROWSER_SNAPSHOT_ENV] = previousBrowserSnapshot;
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

  test("reports browser read-only connector unavailable without fabricating browser verification", async () => {
    const { db, dir } = await openFixtureRuntime();
    delete process.env[BROWSER_SNAPSHOT_ENV];
    try {
      const config = buildConfig({ cliConnectorDirs: [dir] });
      const router = createDefaultRouter({ config, database: db });

      const response = await router.handle(new Request(`${BASE_URL}/api/pi/connectors`));
      const body = await response.json() as ConnectorHealthBody;
      const connector = body.connectors.find((item) => item.id === "browser-readonly");

      expect(response.status).toBe(200);
      expect(connector).toMatchObject({
        enabled: false,
        kind: "browser",
        missing_required: [BROWSER_SNAPSHOT_ENV],
        status: "disabled",
        health: {
          checked: false,
          ok: false,
          status: "skipped",
          error: { code: "browser_unavailable" }
        },
        summary: expect.objectContaining({
          configured: false,
          read_only: true,
          tool: "read_page_context",
          unavailable_diagnostic: "browser_unavailable"
        })
      });
    } finally {
      db.close();
    }
  });

  test("tests a local webhook connection and audits the result", async () => {
    const { db } = await openFixtureRuntime();
    try {
      const config = buildConfig({ stateDir: dirname(db.path) });
      const router = createDefaultRouter({ config, database: db, webhookSigningSecret: "webhook-fixture-secret" });
      const response = await router.handle(new Request(`${BASE_URL}/api/pi/connectors/webhook/test-connection`, {
        body: JSON.stringify({ reason: "fixture test" }), method: "POST"
      }));
      const body = await response.json() as { result: { ok: boolean; state: string } };
      const audit = db.sqlite.query<{ payload_json: string; result_json: string }, []>(
        "select payload_json, result_json from pi_action_events where event_type='connector.tested' order by id desc limit 1"
      ).get();

      expect(response.status).toBe(200);
      expect(body.result).toMatchObject({ ok: true, state: "healthy" });
      expect(JSON.parse(audit?.payload_json ?? "{}")).toEqual({ connector_id: "webhook" });
      expect(audit?.result_json).not.toContain("webhook-fixture-secret");
    } finally {
      db.close();
    }
  });

  test("revokes only a declared secret ref, clears runtime material and returns no value", async () => {
    const { db } = await openFixtureRuntime();
    try {
      const secrets = createDatabaseSecretService(db);
      const metadata = secrets.put("integrations/github/token", "github-fixture-secret", "fixture", "setup");
      const config = buildConfig({
        githubToken: "github-fixture-secret",
        githubTokenRef: metadata.ref,
        stateDir: dirname(db.path)
      });
      const router = createDefaultRouter({ config, database: db });
      const diagnosticResponse = await router.handle(new Request(`${BASE_URL}/api/pi/connectors/diagnostics`));
      const diagnosticText = await diagnosticResponse.text();
      const response = await router.handle(new Request(`${BASE_URL}/api/pi/connectors/github-events/revoke`, {
        body: JSON.stringify({ reason: "fixture revoke", secret_ref: metadata.ref }), method: "POST"
      }));
      const text = await response.text();
      const body = JSON.parse(text) as { secret: { status: string } };

      expect(diagnosticResponse.status).toBe(200);
      expect(JSON.parse(diagnosticText)).toMatchObject({ schema_version: "xuanwu.connector-diagnostics.v1" });
      expect(diagnosticText).not.toContain("github-fixture-secret");
      expect(response.status).toBe(200);
      expect(body.secret.status).toBe("revoked");
      expect(config.integrations.github.token).toBe("");
      expect(() => secrets.resolve(metadata.ref)).toThrow("secret is revoked");
      expect(text).not.toContain("github-fixture-secret");
      expect(db.sqlite.query<{ count: number }, []>(
        "select count(*) as count from pi_action_events where event_type='secret.revoked'"
      ).get()?.count).toBe(1);
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
