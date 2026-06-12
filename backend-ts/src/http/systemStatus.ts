import { statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join, relative } from "node:path";
import { bunBuildInfo } from "../buildInfo.ts";
import type { RunnerConfig, ProviderRuntimeConfig } from "../config/env.ts";
import { feishuConnectorStatus } from "../integrations/feishu.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { ExecutorCapability } from "../providers/types.ts";
import { runningProjectLoopCount } from "../runner/projectLoopManager.ts";
import { redactSensitiveText } from "../util/redact.ts";

type SystemStatusContext = {
  authEnabled: boolean;
  config: RunnerConfig;
  database: RunnerDatabase;
  startedAt: Date;
};

type CheckStatus = { ok: boolean; error?: string };
type ProviderStatus = ReturnType<typeof providerStatus>[number];

export function buildSystemStatus(context: SystemStatusContext): Record<string, unknown> {
  const providers = providerStatus(context.config);
  return {
    service: serviceStatus(context.startedAt),
    db: databaseStatus(context.database),
    auth: { enabled: context.authEnabled },
    config: configStatus(context),
    security: { warnings: securityWarnings(context.config.addr, context.authEnabled) },
    codex: codexStatus(context.config),
    providers,
    connectors: connectorStatus(context.config),
    runner: runnerStatus(context.database)
  };
}

export function buildRuntimeDoctor(context: SystemStatusContext): Record<string, unknown> {
  const status = buildSystemStatus(context) as RuntimeStatus;
  return {
    generated_at: new Date().toISOString(),
    service: status.service,
    listen: { addr: status.config.addr },
    auth: { enabled: status.auth.enabled, current_request_authorized: true },
    security: status.security,
    db: { ...status.db, path: status.config.db_path, path_visible: status.db.ok },
    runner: status.runner,
    projects: [],
    providers: status.providers.map(doctorProvider),
    connectors: status.connectors,
    recent_errors: { count: 0, sources: [] }
  };
}

export function summarizeRuntimePath(path: string, stateDir: string): string {
  const cleanPath = path.trim();
  const cleanStateDir = stateDir.trim();
  if (cleanPath === "") return "";
  if (cleanStateDir !== "") return summarizeRelativePath(cleanPath, cleanStateDir);
  return `<${basename(cleanPath) || "path"}>`;
}

function serviceStatus(startedAt: Date): Record<string, unknown> {
  const build = bunBuildInfo();
  return {
    alive: true,
    name: "codex-issue-runner backend-ts",
    runtime: "bun",
    bun_version: build.bun_version,
    version: build.version,
    build,
    started_at: startedAt.toISOString()
  };
}

function databaseStatus(database: RunnerDatabase): CheckStatus {
  try {
    database.sqlite.query("select 1 as ok").get();
    return { ok: true };
  } catch {
    return { ok: false, error: "database query failed" };
  }
}

function configStatus(context: SystemStatusContext): Record<string, unknown> {
  return {
    addr: context.config.addr,
    db_path: summarizeRuntimePath(context.database.path, context.config.stateDir),
    auth_enabled: context.authEnabled,
    origin_policy: "local_only",
    web_mode: context.config.webDir.trim() === "" ? "api_only" : "external",
    web_dir: summarizeRuntimePath(context.config.webDir, context.config.stateDir)
  };
}

function securityWarnings(addr: string, authEnabled: boolean): Array<Record<string, string>> {
  const warnings: Array<Record<string, string>> = [];
  if (bindsAllInterfaces(addr)) {
    warnings.push({ code: "bind_all_interfaces", message: "service listens on all interfaces" });
  }
  if (!authEnabled) {
    warnings.push({ code: "auth_disabled", message: "API bearer token auth is disabled" });
  }
  return warnings;
}

function codexStatus(config: RunnerConfig): Record<string, unknown> {
  const codex = config.providers.codex;
  const command = redactSensitiveText(codex?.command ?? "");
  const capabilities = codexCapabilities();
  return {
    command,
    command_ok: command.trim() !== "",
    capability_summary: capabilities.join(","),
    capabilities,
    app_server: "not_checked",
    model_list: "not_checked"
  };
}

export function providerStatus(config: RunnerConfig): Array<{
  available: boolean;
  capabilities: string[];
  cli: Record<string, unknown>;
  command: string;
  cwd_configured: boolean;
  default_model?: string;
  enabled: boolean;
  env_keys: string[];
  id: string;
  label: string;
  role: string;
  secrets: Record<string, { configured: boolean }>;
  settings_mode: string;
  status: string;
  timeout_ms: number;
}> {
  const out = [];
  const codex = config.providers.codex;
  if (codex) out.push(providerEntry({
    capabilities: codexCapabilities(),
    config: codex,
    id: "codex",
    label: "Codex",
    settingsMode: "env_or_codex_config"
  }));
  const claude = config.providers.claude;
  if (claude) out.push(providerEntry({
    capabilities: claudeCapabilities(),
    config: claude,
    defaultModel: claude.model ?? "",
    id: "claude",
    label: "Claude Code",
    settingsMode: "env_or_provider_login"
  }));
  return out;
}

function connectorStatus(config: RunnerConfig): Array<Record<string, unknown>> {
  return [feishuConnectorStatus(config.integrations.feishu)];
}

function providerEntry(input: {
  capabilities: ExecutorCapability[];
  config: ProviderRuntimeConfig;
  defaultModel?: string;
  id: string;
  label: string;
  settingsMode: string;
}) {
  const cli = cliStatus(input.config);
  return {
    id: input.id,
    label: input.label,
    role: "executor",
    status: cli.available ? "available" : "missing",
    available: cli.available,
    enabled: true,
    capabilities: input.capabilities,
    command: redactSensitiveText(input.config.command),
    cli,
    cwd_configured: input.config.cwd.trim() !== "",
    ...(input.defaultModel === undefined ? {} : { default_model: redactSensitiveText(input.defaultModel) }),
    env_keys: diagnosticEnvKeys(input.config.env),
    secrets: { api_key: { configured: hasConfiguredApiKey(input.config.env, input.id) } },
    settings_mode: input.settingsMode,
    timeout_ms: input.config.timeoutMs
  };
}

function cliStatus(config: ProviderRuntimeConfig): Record<string, unknown> & { available: boolean } {
  const command = redactSensitiveText(config.command.trim());
  if (command === "") return { command: "", available: false, error: "command is empty" };
  const binary = firstCommandPart(command);
  const path = findExecutable(binary, config.env);
  const base = { command, available: path !== "" };
  if (path === "") return { ...base, error: `exec: "${binary}" not found in PATH` };
  const version = commandVersion(path, config.env);
  return { ...base, path: redactSensitiveText(path), ...(version === "" ? {} : { version }) };
}

function firstCommandPart(command: string): string {
  const match = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/)?.[0] ?? "";
  return unquoteArg(match);
}

function unquoteArg(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

function findExecutable(command: string, env: Record<string, string>): string {
  if (command === "") return "";
  if (command.includes("/")) return isExecutable(command) ? command : "";
  const overridePath = env.PATH;
  if (overridePath !== undefined) return findInPath(command, overridePath);
  return Bun.which(command) ?? findInPath(command, Bun.env.PATH ?? "");
}

function findInPath(command: string, pathEnv: string): string {
  for (const dir of pathEnv.split(delimiter)) {
    const candidate = join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  return "";
}
function isExecutable(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}
function commandVersion(path: string, env: Record<string, string>): string {
  try {
    const result = Bun.spawnSync([path, "--version"], { env: { ...Bun.env, ...env }, stderr: "pipe", stdout: "pipe" });
    if (result.exitCode !== 0) return "";
    return redactSensitiveText(new TextDecoder().decode(result.stdout).trim());
  } catch {
    return "";
  }
}

function codexCapabilities(): ExecutorCapability[] {
  return ["issue_execution", "sessions", "resume_session", "interrupt", "approvals", "model_list"];
}

function claudeCapabilities(): ExecutorCapability[] {
  return ["issue_execution"];
}

function diagnosticEnvKeys(env: Record<string, string>): string[] {
  return Object.keys(env).filter((key) => !isSensitiveEnvKey(key)).sort();
}

function isSensitiveEnvKey(key: string): boolean {
  return /(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|ACCESS[_-]?KEY)/i.test(key);
}

function hasConfiguredApiKey(env: Record<string, string>, provider: string): boolean {
  const keys = provider === "claude"
    ? ["ANTHROPIC_API_KEY"]
    : ["CODEX_API_KEY", "OPENAI_API_KEY"];
  return keys.some((key) => (env[key] ?? Bun.env[key] ?? "").trim() !== "");
}

function runnerStatus(database: RunnerDatabase): Record<string, number> {
  return {
    auto_run_projects: countRows(database, "select count(*) as count from projects where auto_run=1"),
    running_loops: runningProjectLoopCount(),
    held_projects: countRows(database, "select count(*) as count from project_holds"),
    in_progress_issues: countRows(database, "select count(*) as count from issues where status='in_progress'"),
    running_issues: countRows(database, "select count(*) as count from issue_runs where ended_at=''"),
    running_sessions: countRows(database, "select count(*) as count from agent_sessions where status in ('running','inProgress')")
  };
}

function countRows(database: RunnerDatabase, sql: string): number {
  return database.sqlite.query<{ count: number }, []>(sql).get()?.count ?? 0;
}

function doctorProvider(provider: ProviderStatus): Record<string, unknown> {
  return {
    id: provider.id,
    label: provider.label,
    status: provider.status,
    available: provider.available,
    enabled: provider.enabled,
    capabilities: provider.capabilities
  };
}

function summarizeRelativePath(path: string, stateDir: string): string {
  const relativePath = relative(stateDir, path);
  if (relativePath === "") return "<stateDir>";
  if (isSafeRelativePath(relativePath)) return `<stateDir>/${relativePath.replaceAll("\\", "/")}`;
  return `<${basename(path) || "path"}>`;
}

function isSafeRelativePath(path: string): boolean {
  return !path.startsWith("..") && !isAbsolute(path);
}

function bindsAllInterfaces(addr: string): boolean {
  const clean = addr.trim();
  return clean.startsWith(":") || clean.startsWith("0.0.0.0:") || clean.startsWith("[::]:");
}

type RuntimeStatus = {
  auth: { enabled: boolean };
  config: { addr: string; db_path: string };
  db: CheckStatus;
  connectors: Array<Record<string, unknown>>;
  providers: ProviderStatus[];
  runner: Record<string, number>;
  security: Record<string, unknown>;
  service: Record<string, unknown>;
};
