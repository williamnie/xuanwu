import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ENV_KEYS, loadConfig } from "./env.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { tempStateDir } from "./envTestFixtures.ts";

export function registerEnvCredentialsCases() {
  test("lets CLI flags override environment", () => {
    const env = { [ENV_KEYS.addr]: "127.0.0.1:3999", [ENV_KEYS.authToken]: "env-token" };
    const config = loadConfig([
      "serve",
      "--addr", "127.0.0.1:4018",
      "--agentic-addr", "127.0.0.1:4019",
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
      "--max-parallel-projects", "4",
      "--cli-connector-dirs", "/tmp/cli-connectors",
      "--claude-cmd", "cli-claude",
      "--claude-cwd=/tmp/cli-claude-project",
      "--claude-env", "ANTHROPIC_API_KEY=cli-secret",
      "--claude-model", "claude-opus",
      "--claude-timeout-ms", "6789",
      "--pi-cmd", "cli-pi --offline",
      "--pi-cwd=/tmp/cli-pi-project",
      "--pi-enabled", "false",
      "--pi-env", "SAFE_PI=cli-ok",
      "--pi-timeout-ms", "7890"
    ], env);

    expect(config).toEqual({
      addr: "127.0.0.1:4018",
      agenticAddr: "127.0.0.1:4019",
      stateDir: "/tmp/cli-state",
      dbPath: "/tmp/cli.db",
      authToken: "cli-token",
      authTokenFile: "/tmp/cli-token",
      codexServer: {
        appCommand: expect.any(String),
        appEnv: {},
        cliCommand: "cli-codex app-server --listen stdio://",
        mode: "cli"
      },
      codexSessionsDir: "/tmp/cli-sessions",
      webDir: "/tmp/cli-web",
      cliConnectors: { manifestDirs: ["/tmp/cli-connectors"] },
      providers: {
        codex: {
          command: "cli-codex app-server --listen stdio://",
          cwd: "/tmp/cli-project",
          enabled: true,
          env: { CODEX_HOME: "/tmp/cli-codex" },
          timeoutMs: 5678
        },
        claude: {
          apiBaseUrl: "",
          apiPath: "",
          authMode: "environment",
          command: "cli-claude",
          cwd: "/tmp/cli-claude-project",
          enabled: true,
          env: { ANTHROPIC_API_KEY: "cli-secret" },
          mode: "sdk",
          model: "claude-opus",
          platformConfigDir: "",
          platformProfile: "",
          timeoutMs: 6789
        },
        "pi-coding-agent": {
          command: "cli-pi --offline",
          cwd: "/tmp/cli-pi-project",
          enabled: false,
          env: { SAFE_PI: "cli-ok" },
          timeoutMs: 7890
        },
        qoder: {
          authMode: "local-cli",
          command: "qodercli",
          configDir: "",
          credential: "",
          credentialRef: "",
          cwd: "",
          enabled: true,
          env: {},
          mode: "sdk",
          model: "",
          timeoutMs: 1_800_000
        }
      },
      runner: { maxParallelProjects: 4 },
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
        },
        telegram: {
          allowedChatIds: [], allowedUserIds: [], botToken: "", botTokenRef: "", defaultChatId: "",
          enabled: false, getMeCacheTtlSeconds: 300, pollTimeoutSeconds: 25, projectMappings: [], receiveMode: "long_polling"
        },
        github: {
          api_base_url: "https://api.github.com",
          display_name: "GitHub",
          git_base_url: "https://github.com",
          issueSync: expect.objectContaining({ enabled: false, repositories: [] }),
          graphql_base_url: "https://api.github.com/graphql",
          provider_id: "github",
          token: "",
          token_ref: "env://GITHUB_TOKEN",
          web_base_url: "https://github.com"
        },
        gitlab: {
          api_base_url: "https://gitlab.com/api/v4",
          display_name: "GitLab",
          git_base_url: "https://gitlab.com",
          provider_id: "gitlab",
          token: "",
          token_ref: "env://GITLAB_TOKEN",
          web_base_url: "https://gitlab.com"
        }
      }
    });
  });

  test("maps Runner Claude SDK base/path/key settings without exposing a key CLI flag", () => {
    const config = loadConfig([
      "--claude-mode", "sdk",
      "--claude-api-base-url", "https://gateway.example/v1/",
      "--claude-api-path", "/anthropic/",
      "--claude-model", "claude-sonnet"
    ], {
      [ENV_KEYS.claudeApiKey]: "sdk-secret",
      [ENV_KEYS.claudeEnv]: "SAFE_CLAUDE=ok"
    });

    expect(config.providers.claude).toMatchObject({
      apiBaseUrl: "https://gateway.example/v1/anthropic",
      apiPath: "/anthropic",
      env: {
        ANTHROPIC_API_KEY: "sdk-secret",
        ANTHROPIC_BASE_URL: "https://gateway.example/v1/anthropic",
        SAFE_CLAUDE: "ok"
      },
      mode: "sdk",
      model: "claude-sonnet"
    });
    expect(() => loadConfig(["--claude-api-key", "must-not-appear-in-process-args"], {})).toThrow("Unknown config argument");
  });

  test("loads a persisted Claude API key file without exposing it in process arguments", async () => {
    const stateDir = await tempStateDir();
    const keyFile = join(stateDir, "claude_api_key");
    await writeFile(keyFile, "sdk-file-secret\n", { mode: 0o600 });

    const config = loadConfig([], {
      [ENV_KEYS.claudeApiKeyFile]: keyFile,
      [ENV_KEYS.claudeApiBaseUrl]: "https://gateway.example"
    });

    expect(config.providers.claude?.env).toEqual({
      ANTHROPIC_API_KEY: "sdk-file-secret",
      ANTHROPIC_BASE_URL: "https://gateway.example"
    });
    expect(config.providers.claude).not.toHaveProperty("apiKeyFile");
  });

  test("preserves the SDK standard auth token variables in the isolated Claude environment", () => {
    const config = loadConfig([], {
      ANTHROPIC_AUTH_TOKEN: "anthropic-auth-token",
      CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth-token"
    });

    expect(config.providers.claude?.env).toEqual({
      ANTHROPIC_AUTH_TOKEN: "anthropic-auth-token",
      CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth-token"
    });
    expect(redactSensitiveText("anthropic-auth-token claude-oauth-token")).toBe("[redacted] [redacted]");
  });
}
