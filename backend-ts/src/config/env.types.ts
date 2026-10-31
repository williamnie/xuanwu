import { type CodexServerMode } from "./codexServer.ts";
import type { FeishuConfigInput, FeishuConnectorConfig, FeishuConnectorOverrides } from "../integrations/feishu/feishu.ts";
import type { TelegramConfigInput, TelegramConnectorConfig, TelegramConnectorOverrides } from "../integrations/telegram/telegramTypes.ts";
import { type GitHubConnectorConfig, type GitHubConnectorConfigInput } from "../integrations/github/config.ts";
import { type GitLabConnectorConfig, type GitLabConnectorConfigInput } from "../integrations/gitlab/config.ts";
import type { ExecutorProviderId } from "../providers/types.ts";
import type { ENV_KEYS } from "./env.keys.ts";

export type Env = Record<string, string | undefined>;

export type ConfigOverrides =
  Omit<Partial<RunnerConfig>, "cliConnectors" | "integrations" | "runner"> &
  ProviderRuntimeOverrides &
  FeishuConnectorOverrides & TelegramConnectorOverrides & {
  cliConnectorDirs?: string | string[];
  cliConnectors?: { manifestDirs?: string | string[] };
  githubApiUrl?: string;
  githubGraphqlUrl?: string;
  githubServerUrl?: string;
  githubToken?: string;
  githubTokenRef?: string;
  gitlabApiUrl?: string;
  gitlabServerUrl?: string;
  gitlabToken?: string;
  gitlabTokenRef?: string;
  integrations?: {
    feishu?: FeishuConfigInput;
    telegram?: TelegramConfigInput;
    github?: GitHubConnectorConfigInput;
    gitlab?: GitLabConnectorConfigInput;
  };
  runner?: { maxParallelProjects?: unknown };
  runnerMaxParallelProjects?: number | string;
};

export type ConfigKey = keyof typeof ENV_KEYS;

export type ProviderRuntimeConfig = {
  apiBaseUrl?: string;
  apiPath?: string;
  authMode?: "environment" | "local-cli" | "platform-profile" | QoderAuthMode;
  command: string;
  cwd: string;
  enabled?: boolean;
  env: Record<string, string>;
  mode?: "sdk" | "cli-fallback" | "herdr";
  model?: string;
  platformConfigDir?: string;
  platformProfile?: string;
  timeoutMs: number;
  /** Resolved only in memory; never persisted or projected by status APIs. */
  credential?: string;
  credentialRef?: string;
  configDir?: string;
};

export type QoderAuthMode = "pat-env" | "pat-secret-ref" | "service-account-secret-ref" | "local-cli";

export type CodexServerConfig = {
  appCommand: string;
  appEnv: Record<string, string>;
  cliCommand: string;
  mode: CodexServerMode;
};

export type RunnerConcurrencyConfig = {
  maxParallelProjects: number;
};

export type CliConnectorConfig = {
  manifestDirs: string[];
};

export type RunnerConfig = {
  addr: string;
  agenticAddr: string;
  stateDir: string;
  dbPath: string;
  authToken: string;
  authTokenFile: string;
  codexSessionsDir: string;
  webDir: string;
  cliConnectors: CliConnectorConfig;
  codexServer: CodexServerConfig;
  providers: Partial<Record<ExecutorProviderId, ProviderRuntimeConfig>>;
  runner: RunnerConcurrencyConfig;
  integrations: {
    feishu: FeishuConnectorConfig;
    telegram: TelegramConnectorConfig;
    github: GitHubConnectorConfig;
    gitlab: GitLabConnectorConfig;
  };
};

export type ProviderRuntimeOverrides = {
  claudeApiBaseUrl?: string;
  claudeApiKey?: string;
  claudeApiKeyFile?: string;
  claudeApiPath?: string;
  claudeAuthMode?: string;
  claudeAuthToken?: string;
  claudeCommand?: string;
  claudeCwd?: string;
  claudeEnv?: string;
  claudeEnabled?: boolean | string;
  claudeMode?: string;
  claudeModel?: string;
  claudeOauthToken?: string;
  claudePlatformConfigDir?: string;
  claudePlatformProfile?: string;
  claudeTimeoutMs?: number | string;
  codexAppCommand?: string;
  codexCommand?: string;
  codexCwd?: string;
  codexEnv?: string;
  codexEnabled?: boolean | string;
  codexServerMode?: string;
  codexSessionsDir?: string;
  codexTimeoutMs?: number | string;
  piCommand?: string;
  piCwd?: string;
  piEnabled?: boolean | string;
  piEnv?: string;
  piTimeoutMs?: number | string;
  qoderAuthMode?: string;
  qoderCommand?: string;
  qoderConfigDir?: string;
  qoderCredential?: string;
  qoderCredentialRef?: string;
  qoderEnabled?: boolean | string;
  qoderModel?: string;
  qoderPat?: string;
  qoderTimeoutMs?: number | string;
};
