import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ENV_KEYS, buildConfig, loadConfig } from "./env.ts";
import { redactSensitiveText } from "../util/redact.ts";

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
      agenticAddr: "127.0.0.1:3010",
      stateDir: "data-bun",
      dbPath: "data-bun/runner.db",
      authToken: "",
      authTokenFile: "data-bun/auth_token",
      codexServer: {
        appCommand: expect.any(String),
        appEnv: {},
        cliCommand: "codex app-server --listen stdio://",
        mode: "cli"
      },
      codexSessionsDir: `${Bun.env.HOME}/.codex/sessions`,
      webDir: "",
      cliConnectors: { manifestDirs: [] },
      providers: {
        codex: { command: "codex app-server --listen stdio://", cwd: "", env: {}, timeoutMs: 1_800_000 },
        claude: {
          apiBaseUrl: "",
          apiPath: "",
          authMode: "environment",
          command: "claude",
          cwd: "",
          env: {},
          mode: "sdk",
          model: "",
          platformConfigDir: "",
          platformProfile: "",
          timeoutMs: 1_800_000
        }
      },
      runner: { maxParallelProjects: 1 },
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
        github: {
          api_base_url: "https://api.github.com",
          display_name: "GitHub",
          git_base_url: "https://github.com",
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

  test("loads connector config from local settings before falling back to env", async () => {
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
        },
        github: {
          apiBaseUrl: "https://github.local/api/v3",
          graphqlBaseUrl: "https://github.local/api/graphql",
          token: "github-local-secret",
          tokenRef: "local://github/handoff",
          webBaseUrl: "https://github.local"
        },
        gitlab: {
          apiBaseUrl: "https://gitlab.local/api/v4",
          token: "gitlab-local-secret",
          tokenRef: "local://gitlab/handoff",
          webBaseUrl: "https://gitlab.local"
        }
      }
    }), "utf8");

    const config = loadConfig([], {
      [ENV_KEYS.stateDir]: stateDir,
      [ENV_KEYS.feishuAppId]: "cli_env",
      [ENV_KEYS.feishuAppSecret]: "env-secret",
      [ENV_KEYS.feishuVerificationToken]: "env-token",
      [ENV_KEYS.githubToken]: "github-env-secret",
      [ENV_KEYS.gitlabToken]: "gitlab-env-secret"
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
    expect(config.integrations.github).toMatchObject({
      api_base_url: "https://github.local/api/v3",
      git_base_url: "https://github.local",
      graphql_base_url: "https://github.local/api/graphql",
      token: "github-local-secret",
      token_ref: "local://github/handoff",
      web_base_url: "https://github.local"
    });
    expect(config.integrations.gitlab).toMatchObject({
      api_base_url: "https://gitlab.local/api/v4",
      git_base_url: "https://gitlab.local",
      token: "gitlab-local-secret",
      token_ref: "local://gitlab/handoff",
      web_base_url: "https://gitlab.local"
    });
  });

  test("loads Codex server selection from local settings", async () => {
    const stateDir = await tempStateDir();
    await writeFile(join(stateDir, "runner-settings.local.json"), JSON.stringify({
      providers: {
        codex: {
          appCommand: "/Applications/Codex.app/Contents/Resources/codex",
          cliCommand: "local-codex",
          serverMode: "app"
        }
      }
    }), "utf8");

    const config = loadConfig([], {
      [ENV_KEYS.stateDir]: stateDir,
      [ENV_KEYS.codexCommand]: "env-codex"
    });

    expect(config.codexServer).toMatchObject({
      appCommand: "/Applications/Codex.app/Contents/Resources/codex app-server --listen stdio://",
      cliCommand: "local-codex app-server --listen stdio://",
      mode: "app"
    });
    expect(config.providers.codex).toMatchObject({
      command: "/Applications/Codex.app/Contents/Resources/codex app-server --listen stdio://",
      env: expect.objectContaining({ BROWSER_USE_AVAILABLE_BACKENDS: "chrome,iab" })
    });
  });

  test("selects Codex App server mode from environment", () => {
    const config = loadConfig([], {
      [ENV_KEYS.codexServerMode]: "app",
      [ENV_KEYS.codexAppCommand]: "/opt/Codex.app/Contents/Resources/codex",
      [ENV_KEYS.codexEnv]: "SAFE_VALUE=ok"
    });

    expect(config.codexServer).toMatchObject({
      appCommand: "/opt/Codex.app/Contents/Resources/codex app-server --listen stdio://",
      mode: "app"
    });
    expect(config.providers.codex).toMatchObject({
      command: "/opt/Codex.app/Contents/Resources/codex app-server --listen stdio://",
      env: expect.objectContaining({
        BROWSER_USE_AVAILABLE_BACKENDS: "chrome,iab",
        SAFE_VALUE: "ok"
      })
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
      [ENV_KEYS.agenticAddr]: "127.0.0.1:4010",
      [ENV_KEYS.codexCommand]: "/opt/bin/codex app-server --listen stdio://",
      [ENV_KEYS.codexCwd]: "/tmp/project",
      [ENV_KEYS.codexEnv]: "CODEX_HOME=/tmp/codex, SAFE_VALUE=ok, CODEX_API_KEY=secret",
      [ENV_KEYS.codexTimeoutMs]: "1234",
      [ENV_KEYS.runnerMaxParallelProjects]: "3",
      [ENV_KEYS.cliConnectorDirs]: "/tmp/connectors-a,/tmp/connectors-b",
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
      [ENV_KEYS.feishuVerificationToken]: "verify-secret-value",
      [ENV_KEYS.githubApiUrl]: "https://github.example/api/v3",
      [ENV_KEYS.githubGraphqlUrl]: "https://github.example/api/graphql",
      [ENV_KEYS.githubServerUrl]: "https://github.example",
      [ENV_KEYS.githubToken]: "github-secret-value",
      [ENV_KEYS.githubTokenRef]: "env://GITHUB_HANDOFF_TOKEN",
      [ENV_KEYS.gitlabApiUrl]: "https://gitlab.example/api/v4",
      [ENV_KEYS.gitlabServerUrl]: "https://gitlab.example",
      [ENV_KEYS.gitlabToken]: "gitlab-secret-value",
      [ENV_KEYS.gitlabTokenRef]: "env://GITLAB_HANDOFF_TOKEN"
    });
    expect(redactSensitiveText("upstream echoed anthropic-secret")).toBe("upstream echoed [redacted]");

    expect(config).toEqual({
      addr: "127.0.0.1:3999",
      agenticAddr: "127.0.0.1:4010",
      stateDir: "/tmp/state-bun",
      dbPath: "/tmp/runner-bun.db",
      authToken: "env-token",
      authTokenFile: "/tmp/token-bun",
      codexServer: {
        appCommand: expect.any(String),
        appEnv: {},
        cliCommand: "/opt/bin/codex app-server --listen stdio://",
        mode: "cli"
      },
      codexSessionsDir: "/tmp/codex-sessions",
      webDir: "/tmp/frontend-dist",
      cliConnectors: { manifestDirs: ["/tmp/connectors-a", "/tmp/connectors-b"] },
      providers: {
        codex: {
          command: "/opt/bin/codex app-server --listen stdio://",
          cwd: "/tmp/project",
          env: { CODEX_HOME: "/tmp/codex", SAFE_VALUE: "ok", CODEX_API_KEY: "secret" },
          timeoutMs: 1234
        },
        claude: {
          apiBaseUrl: "",
          apiPath: "",
          authMode: "environment",
          command: "/opt/bin/claude",
          cwd: "/tmp/claude-project",
          env: { ANTHROPIC_API_KEY: "anthropic-secret", SAFE_CLAUDE: "ok" },
          mode: "sdk",
          model: "claude-sonnet-4-5",
          platformConfigDir: "",
          platformProfile: "",
          timeoutMs: 2345
        }
      },
      runner: { maxParallelProjects: 3 },
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
        },
        github: {
          api_base_url: "https://github.example/api/v3",
          display_name: "GitHub",
          git_base_url: "https://github.example",
          graphql_base_url: "https://github.example/api/graphql",
          provider_id: "github",
          token: "github-secret-value",
          token_ref: "env://GITHUB_HANDOFF_TOKEN",
          web_base_url: "https://github.example"
        },
        gitlab: {
          api_base_url: "https://gitlab.example/api/v4",
          display_name: "GitLab",
          git_base_url: "https://gitlab.example",
          provider_id: "gitlab",
          token: "gitlab-secret-value",
          token_ref: "env://GITLAB_HANDOFF_TOKEN",
          web_base_url: "https://gitlab.example"
        }
      }
    });
  });

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
      "--claude-timeout-ms", "6789"
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
          env: { CODEX_HOME: "/tmp/cli-codex" },
          timeoutMs: 5678
        },
        claude: {
          apiBaseUrl: "",
          apiPath: "",
          authMode: "environment",
          command: "cli-claude",
          cwd: "/tmp/cli-claude-project",
          env: { ANTHROPIC_API_KEY: "cli-secret" },
          mode: "sdk",
          model: "claude-opus",
          platformConfigDir: "",
          platformProfile: "",
          timeoutMs: 6789
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
        github: {
          api_base_url: "https://api.github.com",
          display_name: "GitHub",
          git_base_url: "https://github.com",
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

  test("maps an Anthropic platform OAuth profile without allowing environment credentials to override it", () => {
    const config = loadConfig([], {
      [ENV_KEYS.claudeAuthMode]: "platform-profile",
      [ENV_KEYS.claudePlatformConfigDir]: "/tmp/anthropic-profile",
      [ENV_KEYS.claudePlatformProfile]: "runner",
      [ENV_KEYS.claudeApiKey]: "must-not-win",
      ANTHROPIC_AUTH_TOKEN: "must-not-win-either"
    });

    expect(config.providers.claude).toMatchObject({
      authMode: "platform-profile",
      env: {
        ANTHROPIC_CONFIG_DIR: "/tmp/anthropic-profile",
        ANTHROPIC_PROFILE: "runner"
      },
      mode: "sdk",
      platformConfigDir: "/tmp/anthropic-profile",
      platformProfile: "runner"
    });
    expect(config.providers.claude?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(config.providers.claude?.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
  });

  test("defaults CLI fallback to local login and fails closed for incompatible auth modes", () => {
    expect(buildConfig({ claudeMode: "cli-fallback" }).providers.claude).toMatchObject({
      authMode: "local-cli",
      mode: "cli-fallback"
    });
    expect(buildConfig({ claudeMode: "cli-fallback", claudeEnv: "ANTHROPIC_API_KEY=key" }).providers.claude).toMatchObject({
      authMode: "environment",
      mode: "cli-fallback"
    });
    expect(() => buildConfig({ claudeMode: "sdk", claudeAuthMode: "local-cli" })).toThrow("requires CODEX_RUNNER_CLAUDE_MODE=cli-fallback");
    expect(() => buildConfig({ claudeMode: "cli-fallback", claudeAuthMode: "platform-profile" })).toThrow("requires CODEX_RUNNER_CLAUDE_MODE=sdk");
    expect(() => buildConfig({ claudeAuthMode: "platform-profile", claudePlatformProfile: "../unsafe" })).toThrow("PLATFORM_PROFILE");
  });

  test("keeps Claude CLI as an explicit fallback and rejects unsafe API bases", () => {
    expect(buildConfig({ claudeMode: "cli-fallback" }).providers.claude?.mode).toBe("cli-fallback");
    expect(() => buildConfig({ claudeApiBaseUrl: "file:///tmp/proxy" })).toThrow("must be an http(s) URL");
  });
});
