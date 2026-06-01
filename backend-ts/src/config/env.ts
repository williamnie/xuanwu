import { DEFAULT_ADDR, buildRunnerPaths } from "./paths.ts";
import type { ExecutorProviderId } from "../providers/types.ts";

export const ENV_KEYS = {
  addr: "CODEX_RUNNER_ADDR",
  stateDir: "CODEX_RUNNER_STATE_DIR",
  dbPath: "CODEX_RUNNER_DB",
  authToken: "CODEX_RUNNER_AUTH_TOKEN",
  authTokenFile: "CODEX_RUNNER_AUTH_TOKEN_FILE",
  codexSessionsDir: "CODEX_RUNNER_CODEX_SESSIONS_DIR",
  webDir: "CODEX_RUNNER_WEB_DIR",
  codexCommand: "CODEX_RUNNER_CODEX_CMD",
  codexCwd: "CODEX_RUNNER_CODEX_CWD",
  codexEnv: "CODEX_RUNNER_CODEX_ENV",
  codexTimeoutMs: "CODEX_RUNNER_CODEX_TIMEOUT_MS",
  claudeCommand: "CODEX_RUNNER_CLAUDE_CMD",
  claudeCwd: "CODEX_RUNNER_CLAUDE_CWD",
  claudeEnv: "CODEX_RUNNER_CLAUDE_ENV",
  claudeModel: "CODEX_RUNNER_CLAUDE_MODEL",
  claudeTimeoutMs: "CODEX_RUNNER_CLAUDE_TIMEOUT_MS"
} as const;

type Env = Record<string, string | undefined>;
type ConfigOverrides = Partial<RunnerConfig> & ProviderRuntimeOverrides;
type ConfigKey = keyof typeof ENV_KEYS;

export type ProviderRuntimeConfig = {
  command: string;
  cwd: string;
  env: Record<string, string>;
  model?: string;
  timeoutMs: number;
};

export type RunnerConfig = {
  addr: string;
  stateDir: string;
  dbPath: string;
  authToken: string;
  authTokenFile: string;
  codexSessionsDir: string;
  webDir: string;
  providers: Partial<Record<ExecutorProviderId, ProviderRuntimeConfig>>;
};

const FLAG_KEYS: Record<string, ConfigKey> = {
  "--addr": "addr",
  "--state-dir": "stateDir",
  "--db": "dbPath",
  "--auth-token": "authToken",
  "--auth-token-file": "authTokenFile",
  "--codex-sessions-dir": "codexSessionsDir",
  "--web-dir": "webDir",
  "--codex-cmd": "codexCommand",
  "--codex-cwd": "codexCwd",
  "--codex-env": "codexEnv",
  "--codex-timeout-ms": "codexTimeoutMs",
  "--claude-cmd": "claudeCommand",
  "--claude-cwd": "claudeCwd",
  "--claude-env": "claudeEnv",
  "--claude-model": "claudeModel",
  "--claude-timeout-ms": "claudeTimeoutMs"
};

export function loadConfig(argv = Bun.argv.slice(2), env: Env = Bun.env): RunnerConfig {
  const envOverrides = readEnvOverrides(env);
  const cliOverrides = parseCliOverrides(stripCommand(argv));
  return buildConfig({ ...envOverrides, ...cliOverrides });
}

export function buildConfig(overrides: ConfigOverrides = {}): RunnerConfig {
  const paths = buildRunnerPaths(overrides);
  return {
    addr: cleanValue(overrides.addr) ?? DEFAULT_ADDR,
    authToken: cleanValue(overrides.authToken) ?? "",
    codexSessionsDir: cleanValue(overrides.codexSessionsDir) ?? defaultCodexSessionsDir(),
    webDir: cleanValue(overrides.webDir) ?? "",
    ...paths,
    providers: {
      codex: buildCodexRuntimeConfig(overrides),
      claude: buildClaudeRuntimeConfig(overrides)
    }
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
    codexCommand: cleanValue(env[ENV_KEYS.codexCommand]),
    codexCwd: cleanValue(env[ENV_KEYS.codexCwd]),
    codexEnv: cleanValue(env[ENV_KEYS.codexEnv]),
    codexTimeoutMs: cleanValue(env[ENV_KEYS.codexTimeoutMs]),
    claudeCommand: cleanValue(env[ENV_KEYS.claudeCommand]),
    claudeCwd: cleanValue(env[ENV_KEYS.claudeCwd]),
    claudeEnv: cleanValue(env[ENV_KEYS.claudeEnv]),
    claudeModel: cleanValue(env[ENV_KEYS.claudeModel]),
    claudeTimeoutMs: cleanValue(env[ENV_KEYS.claudeTimeoutMs])
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
  codexCommand?: string;
  codexCwd?: string;
  codexEnv?: string;
  codexSessionsDir?: string;
  codexTimeoutMs?: number | string;
};

const DEFAULT_CODEX_COMMAND = "codex app-server --listen stdio://";
const DEFAULT_CLAUDE_COMMAND = "claude";
const DEFAULT_PROVIDER_TIMEOUT_MS = 30 * 60 * 1000;

function buildCodexRuntimeConfig(overrides: ProviderRuntimeOverrides): ProviderRuntimeConfig {
  const config = buildProviderRuntimeConfig({
    command: overrides.codexCommand,
    cwd: overrides.codexCwd,
    defaultCommand: DEFAULT_CODEX_COMMAND,
    env: overrides.codexEnv,
    timeoutMs: overrides.codexTimeoutMs
  });
  return { ...config, command: normalizeCodexCommand(config.command) };
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

function normalizeCodexCommand(command: string): string {
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

function defaultCodexSessionsDir(): string {
  const home = cleanValue(Bun.env.HOME);
  return home ? `${home}/.codex/sessions` : "";
}
