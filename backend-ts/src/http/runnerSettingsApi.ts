import { dirname } from "node:path";
import type { RunnerConfig, RunnerConcurrencyConfig } from "../config/env.ts";
import { DEFAULT_MAX_PARALLEL_PROJECTS, MAX_PARALLEL_PROJECTS_LIMIT } from "../config/env.ts";
import { localSettingsPath, updateLocalSettingsFile } from "../config/localSettings.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { kickAutoRunProjects, setProjectLoopMaxParallelProjects, type ProjectLoopRuntime } from "../runner/projectLoopManager.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

type RunnerSettingsContext = ProjectLoopRuntime & {
  config?: RunnerConfig;
};

export function registerRunnerSettingsRoutes(router: Router, context: RunnerSettingsContext): void {
  router.get("/api/runner/settings", () => json(publicRunnerSettings(currentSettings(context), settingsPath(context))));
  router.put("/api/runner/settings", async (request) => {
    return json(await saveRunnerSettings(context, await objectBody(request)));
  });
}

async function saveRunnerSettings(context: RunnerSettingsContext, body: Record<string, unknown>) {
  const path = settingsPath(context);
  const next = normalizeRunnerSettings(body, currentSettings(context));
  await updateLocalSettingsFile(path, (settings) => ({ ...settings, runner: next }));
  applyRuntimeRunnerSettings(context.config, next);
  setProjectLoopMaxParallelProjects(next.maxParallelProjects);
  kickAutoRunProjects(context);
  return publicRunnerSettings(next, path);
}

function publicRunnerSettings(settings: RunnerConcurrencyConfig, path: string): Record<string, unknown> {
  return {
    max_parallel_projects: settings.maxParallelProjects,
    min_parallel_projects: 1,
    max_parallel_projects_limit: MAX_PARALLEL_PROJECTS_LIMIT,
    settings_file: path
  };
}

function normalizeRunnerSettings(
  body: Record<string, unknown>,
  current: RunnerConcurrencyConfig
): RunnerConcurrencyConfig {
  return {
    maxParallelProjects: hasOwn(body, "max_parallel_projects")
      ? strictMaxParallelProjects(body.max_parallel_projects)
      : current.maxParallelProjects
  };
}

function strictMaxParallelProjects(value: unknown): number {
  const parsed = parseInteger(value);
  if (parsed === undefined || parsed < 1 || parsed > MAX_PARALLEL_PROJECTS_LIMIT) {
    throw new HttpError(400, `max_parallel_projects 必须是 1-${MAX_PARALLEL_PROJECTS_LIMIT} 的整数`);
  }
  return parsed;
}

async function objectBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await parseJsonBody(request);
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch (error) {
    if (error instanceof HttpError) throw new HttpError(400, "请求体不是合法 JSON");
    throw error;
  }
}

function currentSettings(context: RunnerSettingsContext): RunnerConcurrencyConfig {
  return context.config?.runner ?? { maxParallelProjects: DEFAULT_MAX_PARALLEL_PROJECTS };
}

function applyRuntimeRunnerSettings(config: RunnerConfig | undefined, next: RunnerConcurrencyConfig): void {
  if (!config) return;
  Object.assign(config.runner, next);
}

function settingsPath(context: RunnerSettingsContext): string {
  return localSettingsPath(context.config?.stateDir || dirname(context.database.path));
}

function parseInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
