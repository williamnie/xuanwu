import { join } from "node:path";

export const DEFAULT_ADDR = "127.0.0.1:3008";
export const DEFAULT_STATE_DIR = "data-bun";
export const DEFAULT_DB_FILE = "runner.db";
export const DEFAULT_AUTH_TOKEN_FILE = "auth_token";

type PathOverrides = {
  stateDir?: string;
  dbPath?: string;
  authTokenFile?: string;
};

export type RunnerPaths = {
  stateDir: string;
  dbPath: string;
  authTokenFile: string;
};

export function buildRunnerPaths(overrides: PathOverrides = {}): RunnerPaths {
  const stateDir = cleanPath(overrides.stateDir) ?? DEFAULT_STATE_DIR;
  return {
    stateDir,
    dbPath: cleanPath(overrides.dbPath) ?? join(stateDir, DEFAULT_DB_FILE),
    authTokenFile: cleanPath(overrides.authTokenFile) ?? join(stateDir, DEFAULT_AUTH_TOKEN_FILE)
  };
}

function cleanPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}
