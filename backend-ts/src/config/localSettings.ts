import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const LOCAL_SETTINGS_FILENAME = "runner-settings.local.json";

export type RunnerLocalSettings = {
  integrations?: { feishu?: Record<string, unknown> };
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
  return Object.keys(feishu).length === 0 ? {} : { integrations: { feishu } };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
