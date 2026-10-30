import type { ConfigKey, Env, ConfigOverrides } from "./env.types.ts";
import { cleanValue } from "./env.values.ts";
import { ENV_KEYS } from "./env.keys.ts";

export const FLAG_KEYS: Record<string, ConfigKey> = {
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

export function readEnvOverrides(env: Env): ConfigOverrides {
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
    telegramAllowedChatIds: cleanValue(env[ENV_KEYS.telegramAllowedChatIds]),
    telegramAllowedUserIds: cleanValue(env[ENV_KEYS.telegramAllowedUserIds]),
    telegramBotToken: cleanValue(env[ENV_KEYS.telegramBotToken]),
    telegramBotTokenRef: cleanValue(env[ENV_KEYS.telegramBotTokenRef]),
    telegramDefaultChatId: cleanValue(env[ENV_KEYS.telegramDefaultChatId]),
    telegramEnabled: cleanValue(env[ENV_KEYS.telegramEnabled]),
    telegramGetMeCacheTtlSeconds: cleanValue(env[ENV_KEYS.telegramGetMeCacheTtlSeconds]),
    telegramPollTimeoutSeconds: cleanValue(env[ENV_KEYS.telegramPollTimeoutSeconds]),
    telegramProjectMappings: cleanValue(env[ENV_KEYS.telegramProjectMappings]),
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

export function parseCliOverrides(argv: string[]): ConfigOverrides {
  const overrides: ConfigOverrides = {};
  for (let index = 0; index < argv.length; index += 1) {
    const parsed = parseFlag(argv, index);
    overrides[parsed.key] = parsed.value;
    index = parsed.index;
  }
  return overrides;
}

export function parseFlag(argv: string[], index: number): { key: ConfigKey; value: string; index: number } {
  const arg = argv[index];
  const [flag, inlineValue] = arg.split("=", 2);
  const key = FLAG_KEYS[flag];
  if (!key) throw new Error(`Unknown config argument: ${arg}`);
  const value = inlineValue ?? argv[index + 1];
  if (cleanValue(value) === undefined) throw new Error(`Missing value for ${flag}`);
  return { key, value, index: inlineValue === undefined ? index + 1 : index };
}

export function stripCommand(argv: string[]): string[] {
  return argv[0] === "serve" ? argv.slice(1) : argv;
}

export function claudeApiKeyFromEnv(env: Env): string | undefined {
  return cleanValue(env[ENV_KEYS.claudeApiKey]) ?? cleanValue(env.ANTHROPIC_API_KEY);
}
