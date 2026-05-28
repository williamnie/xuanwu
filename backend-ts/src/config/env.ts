import { DEFAULT_ADDR, buildRunnerPaths } from "./paths.ts";

export const ENV_KEYS = {
  addr: "CODEX_RUNNER_BUN_ADDR",
  stateDir: "CODEX_RUNNER_BUN_STATE_DIR",
  dbPath: "CODEX_RUNNER_BUN_DB",
  authTokenFile: "CODEX_RUNNER_BUN_AUTH_TOKEN_FILE"
} as const;

type Env = Record<string, string | undefined>;
type ConfigOverrides = Partial<RunnerConfig>;

type ConfigKey = keyof typeof ENV_KEYS;

export type RunnerConfig = {
  addr: string;
  stateDir: string;
  dbPath: string;
  authTokenFile: string;
};

const FLAG_KEYS: Record<string, ConfigKey> = {
  "--addr": "addr",
  "--state-dir": "stateDir",
  "--db": "dbPath",
  "--auth-token-file": "authTokenFile"
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
    ...paths
  };
}

function readEnvOverrides(env: Env): ConfigOverrides {
  return {
    addr: cleanValue(env[ENV_KEYS.addr]),
    stateDir: cleanValue(env[ENV_KEYS.stateDir]),
    dbPath: cleanValue(env[ENV_KEYS.dbPath]),
    authTokenFile: cleanValue(env[ENV_KEYS.authTokenFile])
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
