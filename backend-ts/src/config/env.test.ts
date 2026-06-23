import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ENV_KEYS, buildConfig, loadConfig } from "./env.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

async function tempStateDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "codex-runner-config-"));
  tempRoots.push(path);
  return path;
}

describe("Bun backend config", () => {
  test("uses Bun live defaults", () => {
    expect(buildConfig()).toEqual({
      addr: "127.0.0.1:3008",
      stateDir: "data-bun",
      dbPath: "data-bun/runner.db",
      authToken: "",
      authTokenFile: "data-bun/auth_token",
      codexSessionsDir: `${Bun.env.HOME}/.codex/sessions`,
      webDir: "",
      providers: {
        codex: { command: "codex app-server --listen stdio://", cwd: "", env: {}, timeoutMs: 1_800_000 },
        claude: { command: "claude", cwd: "", env: {}, model: "", timeoutMs: 1_800_000 }
      },
      integrations: {
        feishu: {
          allowedChatIds: [],
          allowedUserIds: [],
          appId: "",
          appSecret: "",
          defaultChatId: "",
          defaultUserId: "",
          encryptKey: "",
          projectMappings: [],
          receiveMode: "websocket",
          verificationToken: ""
        }
      }
    });
  });

  test("expands bare Codex command path to app-server stdio command", () => {
    expect(buildConfig({ codexCommand: "/opt/bin/codex" }).providers.codex).toMatchObject({
      command: "/opt/bin/codex app-server --listen stdio://"
    });
  });

  test("keeps explicit Codex app-server command unchanged", () => {
    expect(buildConfig({ codexCommand: "/opt/bin/codex --profile runner app-server --listen stdio://" }).providers.codex).toMatchObject({
      command: "/opt/bin/codex --profile runner app-server --listen stdio://"
    });
  });

  test("derives db and auth token paths from overridden state dir", () => {
    expect(buildConfig({ stateDir: "/tmp/codex-bun" })).toMatchObject({
      addr: "127.0.0.1:3008",
      stateDir: "/tmp/codex-bun",
      dbPath: "/tmp/codex-bun/runner.db",
      authToken: "",
      authTokenFile: "/tmp/codex-bun/auth_token",
      webDir: ""
    });
  });

  test("loads Feishu connector from local settings file before falling back to env", async () => {
    const stateDir = await tempStateDir();
    await writeFile(join(stateDir, "runner-settings.local.json"), JSON.stringify({
      integrations: {
        feishu: {
          allowedChatIds: ["oc_local"],
          allowedUserIds: ["ou_local"],
          appId: "cli_local",
          appSecret: "local-secret",
          defaultChatId: "oc_default_local",
          defaultUserId: "ou_default_local",
          encryptKey: "local-encrypt",
          projectMappings: "chat:oc_local=local-project",
          receiveMode: "websocket",
          verificationToken: "local-token"
        }
      }
    }), "utf8");

    const config = loadConfig([], {
      [ENV_KEYS.stateDir]: stateDir,
      [ENV_KEYS.feishuAppId]: "cli_env",
      [ENV_KEYS.feishuAppSecret]: "env-secret",
      [ENV_KEYS.feishuVerificationToken]: "env-token"
    });

    expect(config.integrations.feishu).toMatchObject({
      allowedChatIds: ["oc_local"],
      allowedUserIds: ["ou_local"],
      appId: "cli_local",
      appSecret: "local-secret",
      defaultChatId: "oc_default_local",
      defaultUserId: "ou_default_local",
      encryptKey: "local-encrypt",
      projectMappings: [{ chatId: "oc_local", projectId: "local-project" }],
      receiveMode: "websocket",
      verificationToken: "local-token"
    });
  });

  test("reads runtime environment overrides including provider settings", () => {
    const config = loadConfig([], {
      [ENV_KEYS.addr]: "127.0.0.1:3999",
      [ENV_KEYS.stateDir]: "/tmp/state-bun",
      [ENV_KEYS.dbPath]: "/tmp/runner-bun.db",
      [ENV_KEYS.authToken]: "env-token",
      [ENV_KEYS.authTokenFile]: "/tmp/token-bun",
      [ENV_KEYS.codexSessionsDir]: "/tmp/codex-sessions",
      [ENV_KEYS.webDir]: "/tmp/frontend-dist",
      [ENV_KEYS.codexCommand]: "/opt/bin/codex app-server --listen stdio://",
      [ENV_KEYS.codexCwd]: "/tmp/project",
      [ENV_KEYS.codexEnv]: "CODEX_HOME=/tmp/codex, SAFE_VALUE=ok, CODEX_API_KEY=secret",
      [ENV_KEYS.codexTimeoutMs]: "1234",
      [ENV_KEYS.claudeCommand]: "/opt/bin/claude",
      [ENV_KEYS.claudeCwd]: "/tmp/claude-project",
      [ENV_KEYS.claudeEnv]: "ANTHROPIC_API_KEY=anthropic-secret,SAFE_CLAUDE=ok",
      [ENV_KEYS.claudeModel]: "claude-sonnet-4-5",
      [ENV_KEYS.claudeTimeoutMs]: "2345",
      [ENV_KEYS.feishuAllowedChatIds]: "oc_a,oc_b",
      [ENV_KEYS.feishuAllowedUserIds]: "ou_1",
      [ENV_KEYS.feishuAppId]: "cli_app_id",
      [ENV_KEYS.feishuAppSecret]: "app-secret-value",
      [ENV_KEYS.feishuDefaultChatId]: "oc_default",
      [ENV_KEYS.feishuDefaultUserId]: "ou_default",
      [ENV_KEYS.feishuEncryptKey]: "encrypt-secret-value",
      [ENV_KEYS.feishuProjectMappings]: "chat:oc_a=codex-runner",
      [ENV_KEYS.feishuReceiveMode]: "callback",
      [ENV_KEYS.feishuVerificationToken]: "verify-secret-value"
    });

    expect(config).toEqual({
      addr: "127.0.0.1:3999",
      stateDir: "/tmp/state-bun",
      dbPath: "/tmp/runner-bun.db",
      authToken: "env-token",
      authTokenFile: "/tmp/token-bun",
      codexSessionsDir: "/tmp/codex-sessions",
      webDir: "/tmp/frontend-dist",
      providers: {
        codex: {
          command: "/opt/bin/codex app-server --listen stdio://",
          cwd: "/tmp/project",
          env: { CODEX_HOME: "/tmp/codex", SAFE_VALUE: "ok", CODEX_API_KEY: "secret" },
          timeoutMs: 1234
        },
        claude: {
          command: "/opt/bin/claude",
          cwd: "/tmp/claude-project",
          env: { ANTHROPIC_API_KEY: "anthropic-secret", SAFE_CLAUDE: "ok" },
          model: "claude-sonnet-4-5",
          timeoutMs: 2345
        }
      },
      integrations: {
        feishu: {
          allowedChatIds: ["oc_a", "oc_b"],
          allowedUserIds: ["ou_1"],
          appId: "cli_app_id",
          appSecret: "app-secret-value",
          defaultChatId: "oc_default",
          defaultUserId: "ou_default",
          encryptKey: "encrypt-secret-value",
          projectMappings: [{ chatId: "oc_a", projectId: "codex-runner" }],
          receiveMode: "callback",
          verificationToken: "verify-secret-value"
        }
      }
    });
  });

  test("lets CLI flags override environment", () => {
    const env = { [ENV_KEYS.addr]: "127.0.0.1:3999", [ENV_KEYS.authToken]: "env-token" };
    const config = loadConfig([
      "serve",
      "--addr", "127.0.0.1:4018",
      "--state-dir=/tmp/cli-state",
      "--db", "/tmp/cli.db",
      "--auth-token", "cli-token",
      "--auth-token-file", "/tmp/cli-token",
      "--codex-sessions-dir", "/tmp/cli-sessions",
      "--web-dir", "/tmp/cli-web",
      "--codex-cmd", "cli-codex app-server --listen stdio://",
      "--codex-cwd=/tmp/cli-project",
      "--codex-env", "CODEX_HOME=/tmp/cli-codex",
      "--codex-timeout-ms", "5678",
      "--claude-cmd", "cli-claude",
      "--claude-cwd=/tmp/cli-claude-project",
      "--claude-env", "ANTHROPIC_API_KEY=cli-secret",
      "--claude-model", "claude-opus",
      "--claude-timeout-ms", "6789"
    ], env);

    expect(config).toEqual({
      addr: "127.0.0.1:4018",
      stateDir: "/tmp/cli-state",
      dbPath: "/tmp/cli.db",
      authToken: "cli-token",
      authTokenFile: "/tmp/cli-token",
      codexSessionsDir: "/tmp/cli-sessions",
      webDir: "/tmp/cli-web",
      providers: {
        codex: {
          command: "cli-codex app-server --listen stdio://",
          cwd: "/tmp/cli-project",
          env: { CODEX_HOME: "/tmp/cli-codex" },
          timeoutMs: 5678
        },
        claude: {
          command: "cli-claude",
          cwd: "/tmp/cli-claude-project",
          env: { ANTHROPIC_API_KEY: "cli-secret" },
          model: "claude-opus",
          timeoutMs: 6789
        }
      },
      integrations: {
        feishu: {
          allowedChatIds: [],
          allowedUserIds: [],
          appId: "",
          appSecret: "",
          defaultChatId: "",
          defaultUserId: "",
          encryptKey: "",
          projectMappings: [],
          receiveMode: "websocket",
          verificationToken: ""
        }
      }
    });
  });
});
