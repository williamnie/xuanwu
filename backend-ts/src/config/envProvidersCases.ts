import { expect, test } from "bun:test";

import { ENV_KEYS, loadConfig } from "./env.ts";
import { redactSensitiveText } from "../util/redact.ts";

export function registerEnvProvidersCases() {
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
      [ENV_KEYS.piCommand]: "/opt/bin/pi --offline",
      [ENV_KEYS.piCwd]: "/tmp/pi-project",
      [ENV_KEYS.piEnabled]: "false",
      [ENV_KEYS.piEnv]: "SAFE_PI=ok",
      [ENV_KEYS.piTimeoutMs]: "3456",
      [ENV_KEYS.feishuAllowedChatIds]: "oc_a,oc_b",
      [ENV_KEYS.feishuAllowedUserIds]: "ou_1",
      [ENV_KEYS.feishuAppId]: "cli_app_id",
      [ENV_KEYS.feishuAppSecret]: "app-secret-value",
      [ENV_KEYS.feishuDefaultChatId]: "oc_default",
      [ENV_KEYS.feishuDefaultUserId]: "ou_default",
      [ENV_KEYS.feishuEncryptKey]: "encrypt-secret-value",
      [ENV_KEYS.feishuProjectMappings]: "chat:oc_a=xuanwu",
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
          enabled: true,
          env: { CODEX_HOME: "/tmp/codex", SAFE_VALUE: "ok", CODEX_API_KEY: "secret" },
          timeoutMs: 1234
        },
        claude: {
          apiBaseUrl: "",
          apiPath: "",
          authMode: "environment",
          command: "/opt/bin/claude",
          cwd: "/tmp/claude-project",
          enabled: true,
          env: { ANTHROPIC_API_KEY: "anthropic-secret", SAFE_CLAUDE: "ok" },
          mode: "sdk",
          model: "claude-sonnet-4-5",
          platformConfigDir: "",
          platformProfile: "",
          timeoutMs: 2345
        },
        "pi-coding-agent": {
          command: "/opt/bin/pi --offline",
          cwd: "/tmp/pi-project",
          enabled: false,
          env: { SAFE_PI: "ok" },
          timeoutMs: 3456
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
          projectMappings: [{ chatId: "oc_a", projectId: "xuanwu" }],
          receiveMode: "callback",
          verificationToken: "verify-secret-value"
        },
        telegram: {
          allowedChatIds: [], allowedUserIds: [], botToken: "", botTokenRef: "", defaultChatId: "",
          enabled: false, getMeCacheTtlSeconds: 300, pollTimeoutSeconds: 25, projectMappings: [], receiveMode: "long_polling"
        },
        github: {
          api_base_url: "https://github.example/api/v3",
          display_name: "GitHub",
          git_base_url: "https://github.example",
          issueSync: expect.objectContaining({ enabled: false, repositories: [] }),
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
}
