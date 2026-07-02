import { dirname } from "node:path";
import type { CodexServerConfig, RunnerConfig, RunnerConcurrencyConfig } from "../config/env.ts";
import {
  DEFAULT_MAX_PARALLEL_PROJECTS,
  MAX_PARALLEL_PROJECTS_LIMIT,
  buildCodexRuntimeConfig,
  buildCodexServerConfig
} from "../config/env.ts";
import {
  CODEX_SERVER_MODES,
  codexAppIntegrationStatus,
  codexCommandStatus,
  type CodexServerMode
} from "../config/codexServer.ts";
import { localSettingsPath, updateLocalSettingsFile } from "../config/localSettings.ts";
import { kickAutoRunProjects, setProjectLoopMaxParallelProjects, type ProjectLoopRuntime } from "../runner/projectLoopManager.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

export type RunnerSettingsContext = ProjectLoopRuntime & {
  config?: RunnerConfig;
};

type RunnerSettings = RunnerConcurrencyConfig & {
  codexServer: CodexServerConfig;
};

type RuntimeApplyResult = {
  codexTransport: string;
};

export function registerRunnerSettingsRoutes(router: Router, context: RunnerSettingsContext): void {
  router.get("/api/runner/settings", () => json(publicRunnerSettings(currentSettings(context), settingsPath(context))));
  router.put("/api/runner/settings", async (request) => {
    return json(await saveRunnerSettings(context, await objectBody(request)));
  });
}

async function saveRunnerSettings(context: RunnerSettingsContext, body: Record<string, unknown>) {
  const path = settingsPath(context);
  const current = currentSettings(context);
  const next = normalizeRunnerSettings(body, current);
  await updateLocalSettingsFile(path, (settings) => ({
    ...settings,
    providers: { ...settings.providers, codex: localCodexSettings(next.codexServer) },
    runner: { maxParallelProjects: next.maxParallelProjects }
  }));
  const applyResult = await applyRuntimeSettings(context, current, next);
  kickAutoRunProjects(context);
  return { ...publicRunnerSettings(next, path), runtime_apply: applyResult };
}

function publicRunnerSettings(settings: RunnerSettings, path: string): Record<string, unknown> {
  return {
    max_parallel_projects: settings.maxParallelProjects,
    min_parallel_projects: 1,
    max_parallel_projects_limit: MAX_PARALLEL_PROJECTS_LIMIT,
    settings_file: path,
    codex_server_mode: settings.codexServer.mode,
    codex_server_modes: CODEX_SERVER_MODES,
    codex_cli_command: settings.codexServer.cliCommand,
    codex_cli_status: codexCommandStatus(settings.codexServer.cliCommand),
    codex_app_command: settings.codexServer.appCommand,
    codex_effective_command: effectiveCodexCommand(settings.codexServer),
    codex_app_status: codexAppIntegrationStatus(settings.codexServer.appCommand)
  };
}

function normalizeRunnerSettings(body: Record<string, unknown>, current: RunnerSettings): RunnerSettings {
  const maxParallelProjects = hasOwn(body, "max_parallel_projects")
    ? strictMaxParallelProjects(body.max_parallel_projects)
    : current.maxParallelProjects;
  return {
    codexServer: normalizeCodexServerSettings(body, current.codexServer),
    maxParallelProjects
  };
}

function normalizeCodexServerSettings(body: Record<string, unknown>, current: CodexServerConfig): CodexServerConfig {
  const mode = hasOwn(body, "codex_server_mode") ? strictCodexServerMode(body.codex_server_mode) : current.mode;
  return buildCodexServerConfig({
    codexAppCommand: stringField(body, "codex_app_command", current.appCommand),
    codexCommand: stringField(body, "codex_cli_command", current.cliCommand),
    codexServerMode: mode
  });
}

function localCodexSettings(settings: CodexServerConfig): Record<string, string> {
  return {
    appCommand: settings.appCommand,
    cliCommand: settings.cliCommand,
    serverMode: settings.mode
  };
}

async function applyRuntimeSettings(
  context: RunnerSettingsContext,
  current: RunnerSettings,
  next: RunnerSettings
): Promise<RuntimeApplyResult> {
  applyRuntimeRunnerSettings(context.config, next);
  setProjectLoopMaxParallelProjects(next.maxParallelProjects);
  if (!codexServerChanged(current.codexServer, next.codexServer)) return { codexTransport: "unchanged" };
  return { codexTransport: await restartCodexTransportIfIdle(context) };
}

function applyRuntimeRunnerSettings(config: RunnerConfig | undefined, next: RunnerSettings): void {
  if (!config) return;
  Object.assign(config.runner, { maxParallelProjects: next.maxParallelProjects });
  Object.assign(config.codexServer, next.codexServer);
  if (config.providers.codex) {
    Object.assign(config.providers.codex, buildCodexRuntimeConfig({ codexServerMode: next.codexServer.mode }, next.codexServer));
  }
}

async function restartCodexTransportIfIdle(context: RunnerSettingsContext): Promise<string> {
  if (activeExecutorCount(context) > 0) return "deferred_active_sessions";
  const stop = context.providers?.codex?.stop;
  if (!stop) return "not_available";
  await stop.call(context.providers.codex);
  return "restarted";
}

function activeExecutorCount(context: RunnerSettingsContext): number {
  try {
    const issueRuns = countRows(context, "select count(*) as count from issue_runs where ended_at=''");
    const sessions = countRows(context, "select count(*) as count from agent_sessions where status in ('running','inProgress')");
    return issueRuns + sessions;
  } catch {
    return 1;
  }
}

function countRows(context: RunnerSettingsContext, sql: string): number {
  return context.database.sqlite.query<{ count: number }, []>(sql).get()?.count ?? 0;
}

function currentSettings(context: RunnerSettingsContext): RunnerSettings {
  const codexServer = context.config?.codexServer ?? buildCodexServerConfig();
  return {
    codexServer: { ...codexServer, appEnv: { ...codexServer.appEnv } },
    maxParallelProjects: context.config?.runner.maxParallelProjects ?? DEFAULT_MAX_PARALLEL_PROJECTS
  };
}

function settingsPath(context: RunnerSettingsContext): string {
  return localSettingsPath(context.config?.stateDir || dirname(context.database.path));
}

function strictMaxParallelProjects(value: unknown): number {
  const parsed = parseInteger(value);
  if (parsed === undefined || parsed < 1 || parsed > MAX_PARALLEL_PROJECTS_LIMIT) {
    throw new HttpError(400, `max_parallel_projects 必须是 1-${MAX_PARALLEL_PROJECTS_LIMIT} 的整数`);
  }
  return parsed;
}

function strictCodexServerMode(value: unknown): CodexServerMode {
  if (value === "cli" || value === "app") return value;
  throw new HttpError(400, "codex_server_mode 必须是 cli 或 app");
}

function stringField(body: Record<string, unknown>, key: string, current: string): string {
  if (!hasOwn(body, key)) return current;
  if (typeof body[key] !== "string") throw new HttpError(400, `${key} 必须是字符串`);
  const value = body[key].trim();
  if (value === "") throw new HttpError(400, `${key} 不能为空`);
  return value;
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

function effectiveCodexCommand(settings: CodexServerConfig): string {
  return settings.mode === "app" ? settings.appCommand : settings.cliCommand;
}

function codexServerChanged(left: CodexServerConfig, right: CodexServerConfig): boolean {
  return left.mode !== right.mode || effectiveCodexCommand(left) !== effectiveCodexCommand(right);
}
