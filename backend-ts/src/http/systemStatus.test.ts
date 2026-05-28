import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig } from "../config/env.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createDefaultRouter, createRequestHandler, registerSystemStatusRoute } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3018";
const tempRoots: string[] = [];

async function tempPath(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(path);
  return path;
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun system status endpoints", () => {
  test("returns public health payload", async () => {
    const router = createDefaultRouter();

    const response = await router.handle(new Request(`${BASE_URL}/health`));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("returns service db auth and config summary", async () => {
    const { config, database } = await openFixtureRuntime();
    try {
      const router = createDefaultRouter();
      registerSystemStatusRoute(router, {
        authToken: "status-secret",
        config,
        database,
        startedAt: new Date("2026-05-28T00:00:00.000Z")
      });

      const handle = createRequestHandler(router, "status-secret");
      const response = await handle(new Request(`${BASE_URL}/api/system/status`, {
        headers: { authorization: "Bearer status-secret" }
      }));
      const body = await response.json() as SystemStatusBody;

      expect(response.status).toBe(200);
      expect(body.service.alive).toBe(true);
      expect(body.service.runtime).toBe("bun");
      expect(body.db.ok).toBe(true);
      expect(body.auth.enabled).toBe(true);
      expect(body.config.addr).toBe("127.0.0.1:3018");
      expect(body.config.auth_enabled).toBe(true);
      expect(body.config.db_path).toBe("<stateDir>/runner.db");
      expect(body.codex).toMatchObject({
        command: "codex app-server --listen stdio://",
        command_ok: true,
        app_server: "not_checked",
        model_list: "not_checked"
      });
      expect(body.providers).toEqual([{
        id: "codex",
        role: "executor",
        capabilities: ["issue_execution", "sessions", "resume_session", "interrupt", "approvals", "model_list"],
        command: "codex app-server --listen stdio://",
        cwd_configured: false,
        env_keys: [],
        timeout_ms: 1_800_000
      }]);
      expect(body.providers.some((provider) => provider.id === "pi")).toBe(false);
      expect(body.runner.running_loops).toBe(0);
    } finally {
      database.close();
    }
  });

  test("does not leak token or raw paths in status JSON", async () => {
    const secret = "fixture-status-secret";
    const { config, database } = await openFixtureRuntime({
      secret,
      codexCommand: "codex --token=runtime-secret app-server --listen stdio://",
      codexEnv: "CODEX_API_KEY=runtime-secret,SAFE_VALUE=ok"
    });
    try {
      const router = createDefaultRouter();
      registerSystemStatusRoute(router, { authToken: secret, config, database });

      const handle = createRequestHandler(router, secret);
      const response = await handle(new Request(`${BASE_URL}/api/system/status`, {
        headers: { authorization: `Bearer ${secret}` }
      }));
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).not.toContain(secret);
      expect(text).not.toContain(config.stateDir);
      expect(text).not.toContain(config.dbPath);
      expect(text).not.toContain(config.authTokenFile);
      expect(text).not.toContain("auth_token");
      expect(text).not.toContain("runtime-secret");
      expect(text).not.toContain("CODEX_API_KEY");
      expect(text).toContain("SAFE_VALUE");
    } finally {
      database.close();
    }
  });
});

async function openFixtureRuntime(options: {
  codexCommand?: string;
  codexEnv?: string;
  secret?: string;
} = {}): Promise<{
  config: ReturnType<typeof buildConfig>;
  database: RunnerDatabase;
}> {
  const root = await tempPath("codex-runner-bun-status-");
  const stateDir = join(root, "state");
  const config = buildConfig({
    authToken: options.secret,
    codexCommand: options.codexCommand,
    codexEnv: options.codexEnv,
    stateDir
  });
  const database = await openDatabase({ dbPath: config.dbPath, stateDir: config.stateDir });
  return { config, database };
}

type SystemStatusBody = {
  auth: { enabled: boolean };
  config: { addr: string; auth_enabled: boolean; db_path: string };
  db: { ok: boolean };
  codex: Record<string, unknown>;
  providers: Array<{ id: string } & Record<string, unknown>>;
  runner: { running_loops: number };
  service: { alive: boolean; runtime: string };
};
