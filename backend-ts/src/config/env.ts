import { delimiter } from "node:path";
import { readFileSync } from "node:fs";
import { DEFAULT_ADDR, buildRunnerPaths } from "./paths.ts";
import { readLocalSettingsSync } from "./localSettings.ts";
import {
  defaultCodexAppCommand,
  defaultCodexAppEnv,
  defaultCodexCliCommand,
  normalizeCodexServerMode,
  type CodexServerMode
} from "./codexServer.ts";
import { buildFeishuConnectorConfig } from "../integrations/feishu.ts";
import type { FeishuConfigInput, FeishuConnectorConfig, FeishuConnectorOverrides } from "../integrations/feishu.ts";
import { buildGitHubConnectorConfig, type GitHubConnectorConfig, type GitHubConnectorConfigInput } from "../integrations/github/config.ts";
import { buildGitLabConnectorConfig, type GitLabConnectorConfig, type GitLabConnectorConfigInput } from "../integrations/gitlab/config.ts";
import type { ExecutorProviderId } from "../providers/types.ts";
import { resolveLocalSettingsSecretRefs } from "../security/secrets/configRefs.ts";
import { createSecretService, resolveSecretLocator } from "../security/secrets/service.ts";
import { registerSecretForRedaction } from "../security/redactionRegistry.ts";

export const ENV_KEYS = {
  addr: "XUANWU_ADDR",
  agenticAddr: "XUANWU_AGENTIC_ADDR",
  stateDir: "XUANWU_STATE_DIR",
  dbPath: "XUANWU_DB",
  authToken: "XUANWU_AUTH_TOKEN",
  authTokenFile: "XUANWU_AUTH_TOKEN_FILE",
  codexSessionsDir: "XUANWU_CODEX_SESSIONS_DIR",
  webDir: "XUANWU_WEB_DIR",
  codexServerMode: "XUANWU_CODEX_SERVER_MODE",
  codexCommand: "XUANWU_CODEX_CMD",
  codexAppCommand: "XUANWU_CODEX_APP_CMD",
  codexCwd: "XUANWU_CODEX_CWD",
  codexEnv: "XUANWU_CODEX_ENV",
  codexEnabled: "XUANWU_CODEX_ENABLED",
  codexTimeoutMs: "XUANWU_CODEX_TIMEOUT_MS",
  runnerMaxParallelProjects: "XUANWU_MAX_PARALLEL_PROJECTS",
  cliConnectorDirs: "XUANWU_CLI_CONNECTOR_DIRS",
  claudeCommand: "XUANWU_CLAUDE_CMD",
  claudeCwd: "XUANWU_CLAUDE_CWD",
  claudeEnv: "XUANWU_CLAUDE_ENV",
  claudeEnabled: "XUANWU_CLAUDE_ENABLED",
  claudeMode: "XUANWU_CLAUDE_MODE",
  claudeAuthMode: "XUANWU_CLAUDE_AUTH_MODE",
  claudeApiBaseUrl: "XUANWU_CLAUDE_API_BASE_URL",
  claudeApiPath: "XUANWU_CLAUDE_API_PATH",
  claudeApiKey: "XUANWU_CLAUDE_API_KEY",
  claudeApiKeyFile: "XUANWU_CLAUDE_API_KEY_FILE",
  claudePlatformConfigDir: "XUANWU_CLAUDE_PLATFORM_CONFIG_DIR",
  claudePlatformProfile: "XUANWU_CLAUDE_PLATFORM_PROFILE",
  claudeModel: "XUANWU_CLAUDE_MODEL",
  claudeTimeoutMs: "XUANWU_CLAUDE_TIMEOUT_MS",
  piCommand: "XUANWU_PI_CMD",
  piCwd: "XUANWU_PI_CWD",
  piEnabled: "XUANWU_PI_ENABLED",
  piEnv: "XUANWU_PI_ENV",
  piTimeoutMs: "XUANWU_PI_TIMEOUT_MS",
  qoderCommand: "XUANWU_QODER_CMD",
  qoderConfigDir: "XUANWU_QODER_CONFIG_DIR",
  qoderAuthMode: "XUANWU_QODER_AUTH_MODE",
  qoderCredentialRef: "XUANWU_QODER_CREDENTIAL_REF",
  qoderEnabled: "XUANWU_QODER_ENABLED",
  qoderModel: "XUANWU_QODER_MODEL",
  qoderTimeoutMs: "XUANWU_QODER_TIMEOUT_MS",
  feishuAllowedChatIds: "FEISHU_ALLOWED_CHAT_IDS",
  feishuAllowedUserIds: "FEISHU_ALLOWED_USER_IDS",
  feishuAppId: "FEISHU_APP_ID",
  feishuAppSecret: "FEISHU_APP_SECRET",
  feishuDefaultChatId: "FEISHU_DEFAULT_CHAT_ID",
  feishuDefaultUserId: "FEISHU_DEFAULT_USER_ID",
  feishuEncryptKey: "FEISHU_ENCRYPT_KEY",
  feishuProjectMappings: "FEISHU_PROJECT_MAPPINGS",
  feishuReceiveMode: "FEISHU_RECEIVE_MODE",
  feishuVerificationToken: "FEISHU_VERIFICATION_TOKEN",
  githubApiUrl: "GITHUB_API_URL",
  githubGraphqlUrl: "GITHUB_GRAPHQL_URL",
  githubServerUrl: "GITHUB_SERVER_URL",
  githubToken: "GITHUB_TOKEN",
  githubTokenRef: "GITHUB_TOKEN_REF",
  gitlabApiUrl: "GITLAB_API_URL",
  gitlabServerUrl: "GITLAB_SERVER_URL",
  gitlabToken: "GITLAB_TOKEN",
  gitlabTokenRef: "GITLAB_TOKEN_REF"
} as const;

type Env = Record<string, string | undefined>;
type ConfigOverrides =
  Omit<Partial<RunnerConfig>, "cliConnectors" | "integrations" | "runner"> &
  ProviderRuntimeOverrides &
  FeishuConnectorOverrides & {
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
    github?: GitHubConnectorConfigInput;
    gitlab?: GitLabConnectorConfigInput;
  };
  runner?: { maxParallelProjects?: unknown };
  runnerMaxParallelProjects?: number | string;
};
type ConfigKey = keyof typeof ENV_KEYS;

export type ProviderRuntimeConfig = {
  apiBaseUrl?: string;
  apiPath?: string;
  authMode?: "environment" | "local-cli" | "platform-profile" | QoderAuthMode;
  command: string;
  cwd: string;
  enabled?: boolean;
  env: Record<string, string>;
  mode?: "sdk" | "cli-fallback";
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
    github: GitHubConnectorConfig;
    gitlab: GitLabConnectorConfig;
  };
};

const FLAG_KEYS: Record<string, ConfigKey> = {
  "--addr": "addr",
  "--agentic-addr": "agenticAddr",
  "--state-dir": "stateDir",
  "--db": "dbPath",
  "--auth-token": "authToken",
  "--auth-token-file": "authTokenFile",
  "--codex-sessions-dir": "codexSessionsDir",
  "--web-dir": "webDir",
  "--codex-server-mode": "codexServerMode",
  "--codex-cmd": "codexCommand",
  "--codex-app-cmd": "codexAppCommand",
  "--codex-cwd": "codexCwd",
  "--codex-env": "codexEnv",
  "--codex-enabled": "codexEnabled",
  "--codex-timeout-ms": "codexTimeoutMs",
  "--max-parallel-projects": "runnerMaxParallelProjects",
  "--cli-connector-dirs": "cliConnectorDirs",
  "--claude-cmd": "claudeCommand",
  "--claude-cwd": "claudeCwd",
  "--claude-env": "claudeEnv",
  "--claude-enabled": "claudeEnabled",
  "--claude-mode": "claudeMode",
  "--claude-auth-mode": "claudeAuthMode",
  "--claude-api-base-url": "claudeApiBaseUrl",
  "--claude-api-path": "claudeApiPath",
  "--claude-platform-config-dir": "claudePlatformConfigDir",
  "--claude-platform-profile": "claudePlatformProfile",
  "--claude-model": "claudeModel",
  "--claude-timeout-ms": "claudeTimeoutMs",
  "--pi-cmd": "piCommand",
  "--pi-cwd": "piCwd",
  "--pi-enabled": "piEnabled",
  "--pi-env": "piEnv",
  "--pi-timeout-ms": "piTimeoutMs",
  "--qoder-cmd": "qoderCommand",
  "--qoder-config-dir": "qoderConfigDir",
  "--qoder-auth-mode": "qoderAuthMode",
  "--qoder-credential-ref": "qoderCredentialRef",
  "--qoder-enabled": "qoderEnabled",
  "--qoder-model": "qoderModel",
  "--qoder-timeout-ms": "qoderTimeoutMs"
};

export function loadConfig(argv = Bun.argv.slice(2), env: Env = Bun.env): RunnerConfig {
  const envOverrides = readEnvOverrides(env);
  const cliOverrides = parseCliOverrides(stripCommand(argv));
  const baseOverrides = { ...envOverrides, ...cliOverrides };
  const stateDir = buildRunnerPaths(baseOverrides).stateDir;
  const secretService = createSecretService({ stateDir });
  const localOverrides = resolveLocalSettingsSecretRefs(
    readLocalSettingsSync(stateDir),
    secretService,
    env
  );
  const localCodex = localOverrides.providers?.codex ?? {};
  const localClaude = localOverrides.providers?.claude ?? {};
  const localPi = localOverrides.providers?.["pi-coding-agent"] ?? {};
  const localQoder = localOverrides.providers?.qoder ?? {};
  const qoderAuthMode = localQoder.authMode ?? baseOverrides.qoderAuthMode;
  const qoderCredentialRef = localQoder.credentialRef ?? baseOverrides.qoderCredentialRef;
  const qoderCredential = localQoder.credential ?? (
    isQoderSecretRefMode(qoderAuthMode) && qoderCredentialRef
      ? resolveQoderCredential(secretService, qoderCredentialRef, env)
      : undefined
  );
  return buildConfig({
    ...baseOverrides,
    codexServerMode: localCodex.serverMode ?? baseOverrides.codexServerMode,
    codexCommand: localCodex.cliCommand ?? baseOverrides.codexCommand,
    codexAppCommand: localCodex.appCommand ?? baseOverrides.codexAppCommand,
    codexEnabled: localCodex.enabled ?? baseOverrides.codexEnabled,
    claudeEnabled: localClaude.enabled ?? baseOverrides.claudeEnabled,
    piCommand: localPi.command ?? baseOverrides.piCommand,
    piCwd: localPi.cwd ?? baseOverrides.piCwd,
    piEnabled: localPi.enabled ?? baseOverrides.piEnabled,
    piTimeoutMs: localPi.timeoutMs ?? baseOverrides.piTimeoutMs,
    qoderCommand: localQoder.command ?? baseOverrides.qoderCommand,
    qoderConfigDir: localQoder.configDir ?? baseOverrides.qoderConfigDir,
    qoderAuthMode,
    qoderCredential,
    qoderCredentialRef,
    qoderEnabled: localQoder.enabled ?? baseOverrides.qoderEnabled,
    qoderModel: localQoder.model ?? baseOverrides.qoderModel,
    qoderTimeoutMs: localQoder.timeoutMs ?? baseOverrides.qoderTimeoutMs,
    runner: { maxParallelProjects: localOverrides.runner?.maxParallelProjects ?? baseOverrides.runnerMaxParallelProjects },
    integrations: {
      feishu: localOverrides.integrations?.feishu ?? {},
      github: localOverrides.integrations?.github ?? {},
      gitlab: localOverrides.integrations?.gitlab ?? {}
    }
  });
}

function isQoderSecretRefMode(value: string | undefined): boolean {
  return value === "pat-secret-ref" || value === "service-account-secret-ref";
}

function resolveQoderCredential(
  secrets: ReturnType<typeof createSecretService>,
  ref: string,
  env: Env
): string {
  try {
    return resolveSecretLocator(secrets, ref, env);
  } catch {
    return "";
  }
}

export function buildConfig(overrides: ConfigOverrides = {}): RunnerConfig {
  const paths = buildRunnerPaths(overrides);
  const codexServer = buildCodexServerConfig(overrides);
  return {
    addr: cleanValue(overrides.addr) ?? DEFAULT_ADDR,
    agenticAddr: cleanValue(overrides.agenticAddr) ?? "127.0.0.1:3010",
    authToken: cleanValue(overrides.authToken) ?? "",
    codexSessionsDir: cleanValue(overrides.codexSessionsDir) ?? defaultCodexSessionsDir(),
    webDir: cleanValue(overrides.webDir) ?? "",
    ...paths,
    codexServer,
    cliConnectors: buildCliConnectorConfig(overrides),
    providers: {
      codex: buildCodexRuntimeConfig(overrides, codexServer),
      claude: buildClaudeRuntimeConfig(overrides),
      "pi-coding-agent": buildPiRuntimeConfig(overrides),
      qoder: buildQoderRuntimeConfig(overrides)
    },
    runner: buildRunnerConcurrencyConfig(overrides.runner ?? {
      maxParallelProjects: overrides.runnerMaxParallelProjects
    }),
    integrations: {
      feishu: buildFeishuConnectorConfig(effectiveFeishuInput(overrides)),
      github: buildGitHubConnectorConfig(effectiveGitHubInput(overrides)),
      gitlab: buildGitLabConnectorConfig(effectiveGitLabInput(overrides))
    }
  };
}

function buildCliConnectorConfig(overrides: ConfigOverrides): CliConnectorConfig {
  const configured = overrides.cliConnectors?.manifestDirs ?? overrides.cliConnectorDirs;
  return { manifestDirs: parsePathList(configured) };
}

function parsePathList(value: string | string[] | undefined): string[] {
  const parts = Array.isArray(value) ? value : String(value ?? "").split(new RegExp(`[,${escapeRegExp(delimiter)}]`));
  return [...new Set(parts.map((item) => item.trim()).filter(Boolean))];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function effectiveFeishuInput(overrides: ConfigOverrides): FeishuConfigInput {
  const local = overrides.integrations?.feishu ?? {};
  return {
    feishuAllowedChatIds: local.feishuAllowedChatIds ?? local.allowedChatIds ?? overrides.feishuAllowedChatIds,
    feishuAllowedUserIds: local.feishuAllowedUserIds ?? local.allowedUserIds ?? overrides.feishuAllowedUserIds,
    feishuAppId: local.feishuAppId ?? local.appId ?? overrides.feishuAppId,
    feishuAppSecret: local.feishuAppSecret ?? local.appSecret ?? overrides.feishuAppSecret,
    feishuDefaultChatId: local.feishuDefaultChatId ?? local.defaultChatId ?? overrides.feishuDefaultChatId,
    feishuDefaultUserId: local.feishuDefaultUserId ?? local.defaultUserId ?? overrides.feishuDefaultUserId,
    feishuEncryptKey: local.feishuEncryptKey ?? local.encryptKey ?? overrides.feishuEncryptKey,
    feishuProjectMappings: local.feishuProjectMappings ?? local.projectMappings ?? overrides.feishuProjectMappings,
    feishuReceiveMode: local.feishuReceiveMode ?? local.receiveMode ?? overrides.feishuReceiveMode,
    feishuVerificationToken: local.feishuVerificationToken ?? local.verificationToken ?? overrides.feishuVerificationToken
  };
}

function effectiveGitHubInput(overrides: ConfigOverrides): GitHubConnectorConfigInput {
  const local = overrides.integrations?.github ?? {};
  return {
    apiBaseUrl: local.apiBaseUrl ?? local.GITHUB_API_URL ?? overrides.githubApiUrl,
    gitBaseUrl: local.gitBaseUrl ?? local.webBaseUrl ?? local.GITHUB_SERVER_URL ?? overrides.githubServerUrl,
    graphqlBaseUrl: local.graphqlBaseUrl ?? local.GITHUB_GRAPHQL_URL ?? overrides.githubGraphqlUrl,
    token: local.token ?? local.GITHUB_TOKEN ?? overrides.githubToken,
    tokenRef: local.tokenRef ?? local.GITHUB_TOKEN_REF ?? overrides.githubTokenRef,
    webBaseUrl: local.webBaseUrl ?? local.GITHUB_SERVER_URL ?? overrides.githubServerUrl
  };
}

function effectiveGitLabInput(overrides: ConfigOverrides): GitLabConnectorConfigInput {
  const local = overrides.integrations?.gitlab ?? {};
  return {
    apiBaseUrl: local.apiBaseUrl ?? local.GITLAB_API_URL ?? overrides.gitlabApiUrl,
    gitBaseUrl: local.gitBaseUrl ?? local.webBaseUrl ?? local.GITLAB_SERVER_URL ?? overrides.gitlabServerUrl,
    token: local.token ?? local.GITLAB_TOKEN ?? overrides.gitlabToken,
    tokenRef: local.tokenRef ?? local.GITLAB_TOKEN_REF ?? overrides.gitlabTokenRef,
    webBaseUrl: local.webBaseUrl ?? local.GITLAB_SERVER_URL ?? overrides.gitlabServerUrl
  };
}

function readEnvOverrides(env: Env): ConfigOverrides {
  return {
    addr: cleanValue(env[ENV_KEYS.addr]),
    agenticAddr: cleanValue(env[ENV_KEYS.agenticAddr]),
    stateDir: cleanValue(env[ENV_KEYS.stateDir]),
    dbPath: cleanValue(env[ENV_KEYS.dbPath]),
    authToken: cleanValue(env[ENV_KEYS.authToken]),
    authTokenFile: cleanValue(env[ENV_KEYS.authTokenFile]),
    codexSessionsDir: cleanValue(env[ENV_KEYS.codexSessionsDir]),
    webDir: cleanValue(env[ENV_KEYS.webDir]),
    codexServerMode: cleanValue(env[ENV_KEYS.codexServerMode]),
    codexCommand: cleanValue(env[ENV_KEYS.codexCommand]),
    codexAppCommand: cleanValue(env[ENV_KEYS.codexAppCommand]),
    codexCwd: cleanValue(env[ENV_KEYS.codexCwd]),
    codexEnv: cleanValue(env[ENV_KEYS.codexEnv]),
    codexEnabled: cleanValue(env[ENV_KEYS.codexEnabled]),
    codexTimeoutMs: cleanValue(env[ENV_KEYS.codexTimeoutMs]),
    runnerMaxParallelProjects: cleanValue(env[ENV_KEYS.runnerMaxParallelProjects]),
    claudeCommand: cleanValue(env[ENV_KEYS.claudeCommand]),
    claudeCwd: cleanValue(env[ENV_KEYS.claudeCwd]),
    cliConnectorDirs: cleanValue(env[ENV_KEYS.cliConnectorDirs]),
    claudeEnv: cleanValue(env[ENV_KEYS.claudeEnv]),
    claudeEnabled: cleanValue(env[ENV_KEYS.claudeEnabled]),
    claudeMode: cleanValue(env[ENV_KEYS.claudeMode]),
    claudeAuthMode: cleanValue(env[ENV_KEYS.claudeAuthMode]),
    claudeApiBaseUrl: cleanValue(env[ENV_KEYS.claudeApiBaseUrl]) ?? cleanValue(env.ANTHROPIC_BASE_URL),
    claudeApiPath: cleanValue(env[ENV_KEYS.claudeApiPath]),
    claudeApiKey: claudeApiKeyFromEnv(env),
    claudeApiKeyFile: cleanValue(env[ENV_KEYS.claudeApiKeyFile]),
    claudePlatformConfigDir: cleanValue(env[ENV_KEYS.claudePlatformConfigDir]) ?? cleanValue(env.ANTHROPIC_CONFIG_DIR),
    claudePlatformProfile: cleanValue(env[ENV_KEYS.claudePlatformProfile]) ?? cleanValue(env.ANTHROPIC_PROFILE),
    claudeAuthToken: cleanValue(env.ANTHROPIC_AUTH_TOKEN),
    claudeOauthToken: cleanValue(env.CLAUDE_CODE_OAUTH_TOKEN),
    claudeModel: cleanValue(env[ENV_KEYS.claudeModel]),
    claudeTimeoutMs: cleanValue(env[ENV_KEYS.claudeTimeoutMs]),
    piCommand: cleanValue(env[ENV_KEYS.piCommand]),
    piCwd: cleanValue(env[ENV_KEYS.piCwd]),
    piEnabled: cleanValue(env[ENV_KEYS.piEnabled]),
    piEnv: cleanValue(env[ENV_KEYS.piEnv]),
    piTimeoutMs: cleanValue(env[ENV_KEYS.piTimeoutMs]),
    qoderCommand: cleanValue(env[ENV_KEYS.qoderCommand]),
    qoderConfigDir: cleanValue(env[ENV_KEYS.qoderConfigDir]),
    qoderAuthMode: cleanValue(env[ENV_KEYS.qoderAuthMode]),
    qoderCredentialRef: cleanValue(env[ENV_KEYS.qoderCredentialRef]),
    qoderEnabled: cleanValue(env[ENV_KEYS.qoderEnabled]),
    qoderModel: cleanValue(env[ENV_KEYS.qoderModel]),
    qoderPat: cleanValue(env.QODER_PERSONAL_ACCESS_TOKEN),
    qoderTimeoutMs: cleanValue(env[ENV_KEYS.qoderTimeoutMs]),
    feishuAllowedChatIds: cleanValue(env[ENV_KEYS.feishuAllowedChatIds]),
    feishuAllowedUserIds: cleanValue(env[ENV_KEYS.feishuAllowedUserIds]),
    feishuAppId: cleanValue(env[ENV_KEYS.feishuAppId]),
    feishuAppSecret: cleanValue(env[ENV_KEYS.feishuAppSecret]),
    feishuDefaultChatId: cleanValue(env[ENV_KEYS.feishuDefaultChatId]),
    feishuDefaultUserId: cleanValue(env[ENV_KEYS.feishuDefaultUserId]),
    feishuEncryptKey: cleanValue(env[ENV_KEYS.feishuEncryptKey]),
    feishuProjectMappings: cleanValue(env[ENV_KEYS.feishuProjectMappings]),
    feishuReceiveMode: cleanValue(env[ENV_KEYS.feishuReceiveMode]),
    feishuVerificationToken: cleanValue(env[ENV_KEYS.feishuVerificationToken]),
    githubApiUrl: cleanValue(env[ENV_KEYS.githubApiUrl]),
    githubGraphqlUrl: cleanValue(env[ENV_KEYS.githubGraphqlUrl]),
    githubServerUrl: cleanValue(env[ENV_KEYS.githubServerUrl]),
    githubToken: cleanValue(env[ENV_KEYS.githubToken]),
    githubTokenRef: cleanValue(env[ENV_KEYS.githubTokenRef]),
    gitlabApiUrl: cleanValue(env[ENV_KEYS.gitlabApiUrl]),
    gitlabServerUrl: cleanValue(env[ENV_KEYS.gitlabServerUrl]),
    gitlabToken: cleanValue(env[ENV_KEYS.gitlabToken]),
    gitlabTokenRef: cleanValue(env[ENV_KEYS.gitlabTokenRef])
  };
}

function parseCliOverrides(argv: string[]): ConfigOverrides {
  const overrides: ConfigOverrides = {};
  for (let index = 0; index < argv.length; index += 1) {
    const parsed = parseFlag(argv, index);
    overrides[parsed.key] = parsed.value;
    index = parsed.index;
  }
  return overrides;
}

function parseFlag(argv: string[], index: number): { key: ConfigKey; value: string; index: number } {
  const arg = argv[index];
  const [flag, inlineValue] = arg.split("=", 2);
  const key = FLAG_KEYS[flag];
  if (!key) throw new Error(`Unknown config argument: ${arg}`);
  const value = inlineValue ?? argv[index + 1];
  if (cleanValue(value) === undefined) throw new Error(`Missing value for ${flag}`);
  return { key, value, index: inlineValue === undefined ? index + 1 : index };
}

function stripCommand(argv: string[]): string[] {
  return argv[0] === "serve" ? argv.slice(1) : argv;
}

function cleanValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

type ProviderRuntimeOverrides = {
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

const DEFAULT_CLAUDE_COMMAND = "claude";
const DEFAULT_PI_COMMAND = "pi";
const DEFAULT_QODER_COMMAND = "qodercli";
const DEFAULT_PROVIDER_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_MAX_PARALLEL_PROJECTS = 1;
export const MAX_PARALLEL_PROJECTS_LIMIT = 8;

export function buildCodexServerConfig(overrides: ProviderRuntimeOverrides): CodexServerConfig {
  const mode = normalizeCodexServerMode(overrides.codexServerMode);
  const cliCommand = normalizeCodexCommand(cleanValue(overrides.codexCommand) ?? defaultCodexCliCommand());
  const appCommand = normalizeCodexCommand(cleanValue(overrides.codexAppCommand) ?? defaultCodexAppCommand());
  return {
    appCommand,
    appEnv: mode === "app" ? defaultCodexAppEnv(appCommand) : {},
    cliCommand,
    mode
  };
}

export function buildCodexRuntimeConfig(
  overrides: ProviderRuntimeOverrides,
  server = buildCodexServerConfig(overrides)
): ProviderRuntimeConfig {
  const providerEnv = parseEnvOverrides(cleanValue(overrides.codexEnv) ?? "");
  const command = server.mode === "app" ? server.appCommand : server.cliCommand;
  const config = buildProviderRuntimeConfig({
    command,
    cwd: overrides.codexCwd,
    defaultCommand: server.cliCommand,
    env: "",
    timeoutMs: overrides.codexTimeoutMs
  });
  return {
    ...config,
    command: normalizeCodexCommand(config.command),
    enabled: parseBoolean(overrides.codexEnabled, true),
    env: server.mode === "app" ? { ...server.appEnv, ...providerEnv } : providerEnv
  };
}

function buildClaudeRuntimeConfig(overrides: ProviderRuntimeOverrides): ProviderRuntimeConfig {
  const legacyEnv = parseEnvOverrides(cleanValue(overrides.claudeEnv) ?? "");
  const apiPath = normalizeClaudeApiPath(overrides.claudeApiPath);
  const configuredBase = cleanValue(overrides.claudeApiBaseUrl) ?? cleanValue(legacyEnv.ANTHROPIC_BASE_URL) ?? "";
  const apiBaseUrl = joinClaudeApiBase(configuredBase, apiPath);
  const apiKey = cleanValue(overrides.claudeApiKey)
    ?? readSecretFile(overrides.claudeApiKeyFile)
    ?? cleanValue(legacyEnv.ANTHROPIC_API_KEY)
    ?? "";
  const authToken = cleanValue(overrides.claudeAuthToken) ?? cleanValue(legacyEnv.ANTHROPIC_AUTH_TOKEN) ?? "";
  const oauthToken = cleanValue(overrides.claudeOauthToken) ?? cleanValue(legacyEnv.CLAUDE_CODE_OAUTH_TOKEN) ?? "";
  const platformConfigDir = cleanValue(overrides.claudePlatformConfigDir) ?? cleanValue(legacyEnv.ANTHROPIC_CONFIG_DIR) ?? "";
  const platformProfile = normalizeClaudePlatformProfile(
    cleanValue(overrides.claudePlatformProfile) ?? cleanValue(legacyEnv.ANTHROPIC_PROFILE) ?? ""
  );
  const environmentAuthConfigured = Boolean(apiKey || authToken || oauthToken);
  const mode = normalizeClaudeProviderMode(overrides.claudeMode);
  const authMode = normalizeClaudeAuthMode(overrides.claudeAuthMode, mode, environmentAuthConfigured);
  if (authMode !== "environment") {
    delete legacyEnv.ANTHROPIC_API_KEY;
    delete legacyEnv.ANTHROPIC_AUTH_TOKEN;
    delete legacyEnv.CLAUDE_CODE_OAUTH_TOKEN;
  }
  const env = {
    ...legacyEnv,
    ...(apiBaseUrl === "" ? {} : { ANTHROPIC_BASE_URL: apiBaseUrl }),
    ...(authMode === "environment" && apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
    ...(authMode === "environment" && authToken ? { ANTHROPIC_AUTH_TOKEN: authToken } : {}),
    ...(authMode === "environment" && oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken } : {}),
    ...(authMode === "platform-profile" && platformConfigDir ? { ANTHROPIC_CONFIG_DIR: platformConfigDir } : {}),
    ...(authMode === "platform-profile" && platformProfile ? { ANTHROPIC_PROFILE: platformProfile } : {})
  };
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const) {
    if (env[key]) registerSecretForRedaction(env[key]);
  }
  return {
    ...buildProviderRuntimeConfig({
      command: overrides.claudeCommand,
      cwd: overrides.claudeCwd,
      defaultCommand: DEFAULT_CLAUDE_COMMAND,
      env: "",
      timeoutMs: overrides.claudeTimeoutMs
    }),
    apiBaseUrl,
    apiPath,
    authMode,
    enabled: parseBoolean(overrides.claudeEnabled, true),
    env,
    mode,
    model: cleanValue(overrides.claudeModel) ?? "",
    platformConfigDir,
    platformProfile
  };
}

export function buildPiRuntimeConfig(overrides: ProviderRuntimeOverrides): ProviderRuntimeConfig {
  return {
    ...buildProviderRuntimeConfig({
      command: overrides.piCommand,
      cwd: overrides.piCwd,
      defaultCommand: DEFAULT_PI_COMMAND,
      env: overrides.piEnv,
      timeoutMs: overrides.piTimeoutMs
    }),
    enabled: parseBoolean(overrides.piEnabled, true)
  };
}

export function buildQoderRuntimeConfig(overrides: ProviderRuntimeOverrides): ProviderRuntimeConfig {
  const authMode = normalizeQoderAuthMode(overrides.qoderAuthMode);
  const credentialRef = cleanValue(overrides.qoderCredentialRef) ?? "";
  const credential = cleanValue(overrides.qoderCredential) ?? "";
  const pat = cleanValue(overrides.qoderPat) ?? "";
  if (pat) registerSecretForRedaction(pat);
  if (credential) registerSecretForRedaction(credential);
  return {
    ...buildProviderRuntimeConfig({
      command: overrides.qoderCommand,
      cwd: undefined,
      defaultCommand: DEFAULT_QODER_COMMAND,
      env: "",
      timeoutMs: overrides.qoderTimeoutMs
    }),
    authMode,
    configDir: cleanValue(overrides.qoderConfigDir) ?? "",
    credential,
    credentialRef,
    enabled: parseBoolean(overrides.qoderEnabled, true),
    env: authMode === "pat-env" && pat ? { QODER_PERSONAL_ACCESS_TOKEN: pat } : {},
    mode: "sdk",
    model: cleanValue(overrides.qoderModel) ?? ""
  };
}

function normalizeQoderAuthMode(value: string | undefined): QoderAuthMode {
  const mode = cleanValue(value)?.toLowerCase() ?? "local-cli";
  if (mode === "pat-env" || mode === "pat-secret-ref" || mode === "service-account-secret-ref" || mode === "local-cli") {
    return mode;
  }
  throw new Error(
    "XUANWU_QODER_AUTH_MODE must be pat-env, pat-secret-ref, service-account-secret-ref, or local-cli"
  );
}

function claudeApiKeyFromEnv(env: Env): string | undefined {
  return cleanValue(env[ENV_KEYS.claudeApiKey]) ?? cleanValue(env.ANTHROPIC_API_KEY);
}

function readSecretFile(pathValue: string | undefined): string | undefined {
  const path = cleanValue(pathValue);
  if (!path) return undefined;
  try {
    return cleanValue(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function normalizeClaudeProviderMode(value: string | undefined): "sdk" | "cli-fallback" {
  const configured = cleanValue(value)?.toLowerCase();
  const mode = configured ?? "sdk";
  if (mode === "sdk" || mode === "cli-fallback") return mode;
  throw new Error(`XUANWU_CLAUDE_MODE must be sdk or cli-fallback, received ${mode}`);
}

function normalizeClaudeAuthMode(
  value: string | undefined,
  providerMode: "sdk" | "cli-fallback",
  environmentAuthConfigured: boolean
): "environment" | "local-cli" | "platform-profile" {
  const configured = cleanValue(value)?.toLowerCase();
  const mode = configured ?? (!environmentAuthConfigured ? "local-cli" : "environment");
  if (mode !== "environment" && mode !== "local-cli" && mode !== "platform-profile") {
    throw new Error(`XUANWU_CLAUDE_AUTH_MODE must be environment, local-cli, or platform-profile, received ${mode}`);
  }
  if (providerMode === "cli-fallback" && mode === "platform-profile") {
    throw new Error("XUANWU_CLAUDE_AUTH_MODE=platform-profile requires XUANWU_CLAUDE_MODE=sdk");
  }
  return mode;
}

function normalizeClaudePlatformProfile(value: string): string {
  const profile = value.trim();
  if (profile === "") return "";
  if (profile === "." || profile === ".." || !/^[A-Za-z0-9_.-]+$/.test(profile)) {
    throw new Error("XUANWU_CLAUDE_PLATFORM_PROFILE must contain only letters, digits, dot, underscore, or hyphen");
  }
  return profile;
}

function normalizeClaudeApiPath(value: string | undefined): string {
  const path = cleanValue(value) ?? "";
  if (path === "" || path === "/") return "";
  return `/${path.replace(/^\/+|\/+$/g, "")}`;
}

function joinClaudeApiBase(baseValue: string, path: string): string {
  const base = baseValue.trim().replace(/\/+$/, "");
  if (base === "") return "";
  try {
    const parsed = new URL(base);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
  } catch {
    throw new Error("XUANWU_CLAUDE_API_BASE_URL must be an http(s) URL");
  }
  return `${base}${path}`;
}

export function buildRunnerConcurrencyConfig(input: { maxParallelProjects?: unknown } = {}): RunnerConcurrencyConfig {
  return {
    maxParallelProjects: normalizeMaxParallelProjects(input.maxParallelProjects, DEFAULT_MAX_PARALLEL_PROJECTS)
  };
}

function buildProviderRuntimeConfig(input: {
  command?: string;
  cwd?: string;
  defaultCommand: string;
  env?: string;
  timeoutMs?: number | string;
}): ProviderRuntimeConfig {
  return {
    command: cleanValue(input.command) ?? input.defaultCommand,
    cwd: cleanValue(input.cwd) ?? "",
    env: parseEnvOverrides(cleanValue(input.env) ?? ""),
    timeoutMs: parsePositiveInteger(input.timeoutMs, DEFAULT_PROVIDER_TIMEOUT_MS)
  };
}

export function normalizeCodexCommand(command: string): string {
  const parts = splitCommand(command);
  return parts.includes("app-server") ? command : `${command} app-server --listen stdio://`;
}

function splitCommand(command: string): string[] {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(unquoteArg) ?? [];
}

function unquoteArg(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseEnvOverrides(value: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const item of value.split(",")) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    const key = item.slice(0, separator).trim();
    if (key === "") continue;
    env[key] = item.slice(separator + 1).trim();
  }
  return env;
}

function parsePositiveInteger(value: number | string | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  const text = cleanValue(typeof value === "string" ? value : undefined);
  if (text === undefined) return fallback;
  const parsed = Number(text);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value: boolean | string | undefined, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  const text = cleanValue(value)?.toLowerCase();
  if (text === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

export function normalizeMaxParallelProjects(value: unknown, fallback: number): number {
  const parsed = parsePositiveIntegerValue(value);
  if (parsed === undefined) return fallback;
  return Math.min(parsed, MAX_PARALLEL_PROJECTS_LIMIT);
}

function parsePositiveIntegerValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  const text = cleanValue(typeof value === "string" ? value : undefined);
  if (text === undefined) return undefined;
  const parsed = Number(text);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function defaultCodexSessionsDir(): string {
  const home = cleanValue(Bun.env.HOME);
  return home ? `${home}/.codex/sessions` : "";
}
