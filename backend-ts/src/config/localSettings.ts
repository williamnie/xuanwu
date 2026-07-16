import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const LOCAL_SETTINGS_FILENAME = "runner-settings.local.json";

export type RunnerLocalSettings = {
  integrations?: {
    feishu?: Record<string, unknown>;
    github?: Record<string, unknown>;
    gitlab?: Record<string, unknown>;
  };
  providers?: {
    codex?: {
      appCommand?: string;
      cliCommand?: string;
      serverMode?: "cli" | "app";
    };
  };
  runner?: { maxParallelProjects?: number };
};

export function localSettingsPath(stateDir: string): string {
  return join(stateDir, LOCAL_SETTINGS_FILENAME);
}

export function readLocalSettingsSync(stateDir: string): RunnerLocalSettings {
  try {
    return normalizeLocalSettings(JSON.parse(readFileSync(localSettingsPath(stateDir), "utf8")));
  } catch (error) {
    if (isMissingFileError(error) || error instanceof SyntaxError) return {};
    throw error;
  }
}

export async function readLocalSettingsFile(path: string): Promise<RunnerLocalSettings> {
  try {
    return normalizeLocalSettings(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (isMissingFileError(error)) return {};
    if (error instanceof SyntaxError) throw new Error("runner-settings.local.json 不是合法 JSON");
    throw error;
  }
}

export async function writeLocalSettingsFile(path: string, value: RunnerLocalSettings): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export async function updateLocalSettingsFile(
  path: string,
  update: (current: RunnerLocalSettings) => RunnerLocalSettings
): Promise<RunnerLocalSettings> {
  const next = update(await readLocalSettingsFile(path));
  await writeLocalSettingsFile(path, next);
  return next;
}

function normalizeLocalSettings(value: unknown): RunnerLocalSettings {
  const raw = recordValue(value);
  const integrations = recordValue(raw.integrations);
  const feishu = recordValue(integrations.feishu);
  const github = recordValue(integrations.github);
  const gitlab = recordValue(integrations.gitlab);
  const normalizedIntegrations = {
    ...(Object.keys(feishu).length === 0 ? {} : { feishu }),
    ...(Object.keys(github).length === 0 ? {} : { github }),
    ...(Object.keys(gitlab).length === 0 ? {} : { gitlab })
  };
  return {
    ...(Object.keys(normalizedIntegrations).length === 0 ? {} : { integrations: normalizedIntegrations }),
    ...normalizedProviderSettings(raw.providers),
    ...normalizedRunnerSettings(raw.runner)
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizedRunnerSettings(value: unknown): Pick<RunnerLocalSettings, "runner"> {
  const raw = recordValue(value);
  const maxParallelProjects = Number(raw.maxParallelProjects);
  if (!Number.isInteger(maxParallelProjects) || maxParallelProjects <= 0) return {};
  return { runner: { maxParallelProjects } };
}

function normalizedProviderSettings(value: unknown): Pick<RunnerLocalSettings, "providers"> {
  const raw = recordValue(value);
  const codex = normalizedCodexSettings(raw.codex);
  return Object.keys(codex).length === 0 ? {} : { providers: { codex } };
}

function normalizedCodexSettings(value: unknown): NonNullable<NonNullable<RunnerLocalSettings["providers"]>["codex"]> {
  const raw = recordValue(value);
  const serverMode = raw.serverMode === "app" ? "app" : raw.serverMode === "cli" ? "cli" : undefined;
  const cliCommand = stringValue(raw.cliCommand);
  const appCommand = stringValue(raw.appCommand);
  return {
    ...(serverMode ? { serverMode } : {}),
    ...(cliCommand ? { cliCommand } : {}),
    ...(appCommand ? { appCommand } : {})
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
