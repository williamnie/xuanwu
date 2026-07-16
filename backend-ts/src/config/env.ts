import { delimiter } from "node:path";
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

export const ENV_KEYS = {
  addr: "CODEX_RUNNER_ADDR",
  stateDir: "CODEX_RUNNER_STATE_DIR",
  dbPath: "CODEX_RUNNER_DB",
  authToken: "CODEX_RUNNER_AUTH_TOKEN",
  authTokenFile: "CODEX_RUNNER_AUTH_TOKEN_FILE",
  codexSessionsDir: "CODEX_RUNNER_CODEX_SESSIONS_DIR",
  webDir: "CODEX_RUNNER_WEB_DIR",
  codexServerMode: "CODEX_RUNNER_CODEX_SERVER_MODE",
  codexCommand: "CODEX_RUNNER_CODEX_CMD",
  codexAppCommand: "CODEX_RUNNER_CODEX_APP_CMD",
  codexCwd: "CODEX_RUNNER_CODEX_CWD",
  codexEnv: "CODEX_RUNNER_CODEX_ENV",
  codexTimeoutMs: "CODEX_RUNNER_CODEX_TIMEOUT_MS",
  runnerMaxParallelProjects: "CODEX_RUNNER_MAX_PARALLEL_PROJECTS",
  cliConnectorDirs: "CODEX_RUNNER_CLI_CONNECTOR_DIRS",
  claudeCommand: "CODEX_RUNNER_CLAUDE_CMD",
  claudeCwd: "CODEX_RUNNER_CLAUDE_CWD",
  claudeEnv: "CODEX_RUNNER_CLAUDE_ENV",
  claudeModel: "CODEX_RUNNER_CLAUDE_MODEL",
  claudeTimeoutMs: "CODEX_RUNNER_CLAUDE_TIMEOUT_MS",
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
  command: string;
  cwd: string;
  env: Record<string, string>;
  model?: string;
  timeoutMs: number;
};

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
  "--codex-timeout-ms": "codexTimeoutMs",
  "--max-parallel-projects": "runnerMaxParallelProjects",
  "--cli-connector-dirs": "cliConnectorDirs",
  "--claude-cmd": "claudeCommand",
  "--claude-cwd": "claudeCwd",
  "--claude-env": "claudeEnv",
  "--claude-model": "claudeModel",
  "--claude-timeout-ms": "claudeTimeoutMs"
};

export function loadConfig(argv = Bun.argv.slice(2), env: Env = Bun.env): RunnerConfig {
  const envOverrides = readEnvOverrides(env);
  const cliOverrides = parseCliOverrides(stripCommand(argv));
  const baseOverrides = { ...envOverrides, ...cliOverrides };
  const localOverrides = readLocalSettingsSync(buildRunnerPaths(baseOverrides).stateDir);
  const localCodex = localOverrides.providers?.codex ?? {};
  return buildConfig({
    ...baseOverrides,
    codexServerMode: localCodex.serverMode ?? baseOverrides.codexServerMode,
    codexCommand: localCodex.cliCommand ?? baseOverrides.codexCommand,
    codexAppCommand: localCodex.appCommand ?? baseOverrides.codexAppCommand,
    runner: { maxParallelProjects: localOverrides.runner?.maxParallelProjects ?? baseOverrides.runnerMaxParallelProjects },
    integrations: {
      feishu: localOverrides.integrations?.feishu ?? {},
      github: localOverrides.integrations?.github ?? {},
      gitlab: localOverrides.integrations?.gitlab ?? {}
    }
  });
}

export function buildConfig(overrides: ConfigOverrides = {}): RunnerConfig {
  const paths = buildRunnerPaths(overrides);
  const codexServer = buildCodexServerConfig(overrides);
  return {
    addr: cleanValue(overrides.addr) ?? DEFAULT_ADDR,
    authToken: cleanValue(overrides.authToken) ?? "",
    codexSessionsDir: cleanValue(overrides.codexSessionsDir) ?? defaultCodexSessionsDir(),
    webDir: cleanValue(overrides.webDir) ?? "",
    ...paths,
    codexServer,
    cliConnectors: buildCliConnectorConfig(overrides),
    providers: {
      codex: buildCodexRuntimeConfig(overrides, codexServer),
      claude: buildClaudeRuntimeConfig(overrides)
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
    codexTimeoutMs: cleanValue(env[ENV_KEYS.codexTimeoutMs]),
    runnerMaxParallelProjects: cleanValue(env[ENV_KEYS.runnerMaxParallelProjects]),
    claudeCommand: cleanValue(env[ENV_KEYS.claudeCommand]),
    claudeCwd: cleanValue(env[ENV_KEYS.claudeCwd]),
    cliConnectorDirs: cleanValue(env[ENV_KEYS.cliConnectorDirs]),
    claudeEnv: cleanValue(env[ENV_KEYS.claudeEnv]),
    claudeModel: cleanValue(env[ENV_KEYS.claudeModel]),
    claudeTimeoutMs: cleanValue(env[ENV_KEYS.claudeTimeoutMs]),
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
  claudeCommand?: string;
  claudeCwd?: string;
  claudeEnv?: string;
  claudeModel?: string;
  claudeTimeoutMs?: number | string;
  codexAppCommand?: string;
  codexCommand?: string;
  codexCwd?: string;
  codexEnv?: string;
  codexServerMode?: string;
  codexSessionsDir?: string;
  codexTimeoutMs?: number | string;
};

const DEFAULT_CLAUDE_COMMAND = "claude";
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
    env: server.mode === "app" ? { ...server.appEnv, ...providerEnv } : providerEnv
  };
}

function buildClaudeRuntimeConfig(overrides: ProviderRuntimeOverrides): ProviderRuntimeConfig {
  return {
    ...buildProviderRuntimeConfig({
      command: overrides.claudeCommand,
      cwd: overrides.claudeCwd,
      defaultCommand: DEFAULT_CLAUDE_COMMAND,
      env: overrides.claudeEnv,
      timeoutMs: overrides.claudeTimeoutMs
    }),
    model: cleanValue(overrides.claudeModel) ?? ""
  };
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
