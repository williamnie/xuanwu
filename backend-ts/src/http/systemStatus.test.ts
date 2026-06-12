import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig } from "../config/env.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createDefaultRouter, createRequestHandler, registerSystemStatusRoute } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
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
      expect(body.service.version).toBe("0.0.0-dev");
      expect(body.service.build).toMatchObject({
        artifact: "codex-issue-runner",
        bun_version: Bun.version,
        stamp: "",
        version: "0.0.0-dev"
      });
      expect(body.db.ok).toBe(true);
      expect(body.auth.enabled).toBe(true);
      expect(body.config.addr).toBe("127.0.0.1:3008");
      expect(body.config.auth_enabled).toBe(true);
      expect(body.config.db_path).toBe("<stateDir>/runner.db");
      expect(body.codex).toMatchObject({
        command: "codex app-server --listen stdio://",
        command_ok: true,
        capability_summary: "issue_execution,sessions,resume_session,interrupt,approvals,model_list",
        capabilities: ["issue_execution", "sessions", "resume_session", "interrupt", "approvals", "model_list"],
        app_server: "not_checked",
        model_list: "not_checked"
      });
      const codex = body.providers.find((provider) => provider.id === "codex");
      const claude = body.providers.find((provider) => provider.id === "claude");
      expect(codex).toMatchObject({
        id: "codex",
        label: "Codex",
        role: "executor",
        enabled: true,
        capabilities: ["issue_execution", "sessions", "resume_session", "interrupt", "approvals", "model_list"],
        command: "codex app-server --listen stdio://",
        cli: { command: "codex app-server --listen stdio://" },
        cwd_configured: false,
        env_keys: [],
        secrets: { api_key: { configured: false } },
        settings_mode: "env_or_codex_config",
        timeout_ms: 1_800_000
      });
      expect(claude).toMatchObject({
        id: "claude",
        label: "Claude Code",
        role: "executor",
        enabled: true,
        capabilities: ["issue_execution"],
        command: "claude",
        cli: { command: "claude" },
        cwd_configured: false,
        default_model: "",
        env_keys: [],
        secrets: { api_key: { configured: false } },
        settings_mode: "env_or_provider_login",
        timeout_ms: 1_800_000
      });
      expect(body.providers.some((provider) => provider.id === "pi")).toBe(false);
      expect(body.connectors).toEqual([{
        id: "feishu",
        label: "Feishu IM",
        enabled: false,
        status: "disabled",
        settings_mode: "settings_page_or_local_config",
        supported_events: ["message.text", "message.mention"],
        attachment_policy: "metadata_only",
        auto_reply: false,
        secrets: {
          app_id: { configured: false },
          app_secret: { configured: false },
          verification_token: { configured: false },
          encrypt_key: { configured: false, optional: true }
        },
        allowed_chat_count: 0,
        allowed_user_count: 0,
        project_mapping_count: 0,
        missing_required: ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_VERIFICATION_TOKEN"],
        summary: {
          callback_path: "/api/integrations/feishu/events",
          configured: false,
          error: "",
          receive_enabled: false,
          reply_mode: "draft",
          state: "disabled"
        }
      }]);
      expect(body.runner.running_loops).toBe(0);
      expect(body.runner.auto_run_projects).toBe(0);
      expect(body.runner.in_progress_issues).toBe(0);
    } finally {
      database.close();
    }
  });


  test("reports partially configured Feishu connector as error summary", async () => {
    const { config, database } = await openFixtureRuntime({ feishuAppId: "cli_app_id" });
    try {
      const router = createDefaultRouter();
      registerSystemStatusRoute(router, { authToken: "", config, database });

      const response = await router.handle(new Request(`${BASE_URL}/api/system/status`));
      const body = await response.json() as SystemStatusBody;

      expect(response.status).toBe(200);
      expect(body.connectors[0]).toMatchObject({
        enabled: false,
        id: "feishu",
        status: "misconfigured",
        summary: {
          configured: false,
          error: "missing FEISHU_APP_SECRET,FEISHU_VERIFICATION_TOKEN",
          receive_enabled: false,
          reply_mode: "draft",
          state: "error"
        }
      });
    } finally {
      database.close();
    }
  });

  test("reports runner counts from database state", async () => {
    const { config, database } = await openFixtureRuntime();
    try {
      insertRunnerStatusFixture(database);
      const router = createDefaultRouter();
      registerSystemStatusRoute(router, { authToken: "", config, database });

      const response = await router.handle(new Request(`${BASE_URL}/api/system/status`));
      const body = await response.json() as SystemStatusBody;

      expect(response.status).toBe(200);
      expect(body.runner).toMatchObject({
        auto_run_projects: 1,
        held_projects: 1,
        in_progress_issues: 1,
        running_issues: 1,
        running_sessions: 1
      });
    } finally {
      database.close();
    }
  });


  test("reports configured Claude CLI metadata without leaking env secrets", async () => {
    const binDir = await tempPath("codex-runner-bun-claude-bin-");
    await writeFakeExecutable(binDir, "claude", "claude 2.1.114 (Claude Code)");
    const secret = "anthropic-status-secret";
    const { config, database } = await openFixtureRuntime({
      claudeCommand: "claude",
      claudeEnv: `PATH=${binDir},ANTHROPIC_API_KEY=${secret},SAFE_CLAUDE=ok`,
      claudeModel: "claude-sonnet-4-5"
    });
    try {
      const router = createDefaultRouter();
      registerSystemStatusRoute(router, { authToken: "", config, database });

      const response = await router.handle(new Request(`${BASE_URL}/api/system/status`));
      const text = await response.text();
      const body = JSON.parse(text) as SystemStatusBody;
      const claude = body.providers.find((provider) => provider.id === "claude");
      const codex = body.providers.find((provider) => provider.id === "codex");

      expect(response.status).toBe(200);
      expect(claude).toMatchObject({
        id: "claude",
        status: "available",
        available: true,
        capabilities: ["issue_execution"],
        command: "claude",
        cli: { command: "claude", available: true, version: "claude 2.1.114 (Claude Code)" },
        default_model: "claude-sonnet-4-5",
        env_keys: ["PATH", "SAFE_CLAUDE"],
        secrets: { api_key: { configured: true } }
      });
      expect((claude?.cli as { path?: unknown } | undefined)?.path).toBe(`${binDir}/claude`);
      expect(codex?.capabilities).toEqual(["issue_execution", "sessions", "resume_session", "interrupt", "approvals", "model_list"]);
      expect(text).not.toContain(secret);
      expect(text).not.toContain("ANTHROPIC_API_KEY");
    } finally {
      database.close();
    }
  });

  test("returns doctor provider metadata for missing Claude without leaking secrets", async () => {
    const secret = "fixture-doctor-secret";
    const { config, database } = await openFixtureRuntime({
      secret,
      claudeCommand: "missing-claude-for-test",
      claudeEnv: "ANTHROPIC_API_KEY=doctor-secret"
    });
    try {
      const router = createDefaultRouter();
      registerSystemStatusRoute(router, { authToken: secret, config, database });

      const handle = createRequestHandler(router, secret);
      const response = await handle(new Request(`${BASE_URL}/api/system/doctor`, {
        headers: { authorization: `Bearer ${secret}` }
      }));
      const text = await response.text();
      const body = JSON.parse(text) as RuntimeDoctorBody;
      const claude = body.providers.find((provider) => provider.id === "claude");

      expect(response.status).toBe(200);
      expect(body.listen.addr).toBe("127.0.0.1:3008");
      expect(body.db.path).toBe("<stateDir>/runner.db");
      expect(claude).toMatchObject({
        id: "claude",
        label: "Claude Code",
        status: "missing",
        available: false,
        enabled: true,
        capabilities: ["issue_execution"]
      });
      expect(text).not.toContain(secret);
      expect(text).not.toContain("doctor-secret");
      expect(text).not.toContain("ANTHROPIC_API_KEY");
    } finally {
      database.close();
    }
  });

  test("reports configured Feishu connector without leaking secrets", async () => {
    const secret = "fixture-status-secret";
    const { config, database } = await openFixtureRuntime({
      feishuAppId: "cli_app_id",
      feishuAppSecret: "app-secret-value",
      feishuEncryptKey: "encrypt-secret-value",
      feishuVerificationToken: "verify-secret-value",
      secret
    });
    try {
      const router = createDefaultRouter();
      registerSystemStatusRoute(router, { authToken: secret, config, database });

      const handle = createRequestHandler(router, secret);
      const response = await handle(new Request(`${BASE_URL}/api/system/status`, {
        headers: { authorization: `Bearer ${secret}` }
      }));
      const text = await response.text();
      const body = JSON.parse(text) as SystemStatusBody;

      expect(response.status).toBe(200);
      expect(body.connectors[0]).toMatchObject({
        id: "feishu",
        enabled: true,
        status: "configured",
        missing_required: [],
        secrets: {
          app_id: { configured: true },
          app_secret: { configured: true },
          verification_token: { configured: true },
          encrypt_key: { configured: true, optional: true }
        },
        summary: {
          callback_path: "/api/integrations/feishu/events",
          configured: true,
          error: "",
          receive_enabled: true,
          reply_mode: "draft",
          state: "configured"
        }
      });
      expect(text).not.toContain(secret);
      expect(text).not.toContain("app-secret-value");
      expect(text).not.toContain("encrypt-secret-value");
      expect(text).not.toContain("verify-secret-value");
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
  claudeCommand?: string;
  claudeEnv?: string;
  claudeModel?: string;
  codexCommand?: string;
  codexEnv?: string;
  feishuAppId?: string;
  feishuAppSecret?: string;
  feishuEncryptKey?: string;
  feishuVerificationToken?: string;
  secret?: string;
} = {}): Promise<{
  config: ReturnType<typeof buildConfig>;
  database: RunnerDatabase;
}> {
  const root = await tempPath("codex-runner-bun-status-");
  const stateDir = join(root, "state");
  const config = buildConfig({
    authToken: options.secret,
    claudeCommand: options.claudeCommand,
    claudeEnv: options.claudeEnv,
    claudeModel: options.claudeModel,
    codexCommand: options.codexCommand,
    codexEnv: options.codexEnv,
    feishuAppId: options.feishuAppId,
    feishuAppSecret: options.feishuAppSecret,
    feishuEncryptKey: options.feishuEncryptKey,
    feishuVerificationToken: options.feishuVerificationToken,
    stateDir
  });
  const database = await openDatabase({ dbPath: config.dbPath, stateDir: config.stateDir });
  return { config, database };
}

async function writeFakeExecutable(dir: string, name: string, version: string): Promise<void> {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; fi\n`, { mode: 0o755 });
}

function insertRunnerStatusFixture(database: RunnerDatabase): void {
  database.sqlite.run(`insert into projects (id, name, cwd, auto_run, created_at, updated_at)
    values ('demo', 'Demo', '/tmp/demo', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
  database.sqlite.run(`insert into issues (project_id, title, status, created_at, updated_at)
    values ('demo', 'Running', 'in_progress', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
  database.sqlite.run(`insert into issue_runs (id, issue_id, attempt, status, started_at)
    values ('issue-1-attempt-1', 1, 1, 'in_progress', '2026-01-01T00:00:00Z')`);
  database.sqlite.run(`insert into project_holds (project_id, reason, message, hold_since, updated_at)
    values ('demo', 'manual', 'waiting', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
  database.sqlite.run(`insert into agent_sessions
    (session_key, provider, provider_session_id, project_id, issue_id, status, created_at, updated_at)
    values ('codex:thread-1', 'codex', 'thread-1', 'demo', 1, 'running', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
}

type SystemStatusBody = {
  auth: { enabled: boolean };
  config: { addr: string; auth_enabled: boolean; db_path: string };
  db: { ok: boolean };
  codex: Record<string, unknown>;
  connectors: Array<{ id: string } & Record<string, unknown>>;
  providers: Array<{ id: string } & Record<string, unknown>>;
  runner: Record<string, number>;
  service: {
    alive: boolean;
    build: Record<string, unknown>;
    runtime: string;
    version: string;
  };
};

type RuntimeDoctorBody = {
  db: { path: string };
  listen: { addr: string };
  providers: Array<{ id: string } & Record<string, unknown>>;
};
