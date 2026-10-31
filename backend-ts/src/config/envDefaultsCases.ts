import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ENV_KEYS, buildConfig, loadConfig } from "./env.ts";

import { tempStateDir } from "./envTestFixtures.ts";

export function registerEnvDefaultsCases() {
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
        codex: { command: "codex app-server --listen stdio://", cwd: "", enabled: true, env: {}, timeoutMs: 1_800_000 },
        claude: {
          apiBaseUrl: "",
          apiPath: "",
          authMode: "local-cli",
          command: "claude",
          cwd: "",
          enabled: true,
          env: {},
          mode: "sdk",
          model: "",
          platformConfigDir: "",
          platformProfile: "",
          timeoutMs: 1_800_000
        },
        "pi-coding-agent": { command: "pi", cwd: "", enabled: true, env: {}, timeoutMs: 1_800_000 },
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
}
