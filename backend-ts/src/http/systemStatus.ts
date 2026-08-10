import { statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join, relative } from "node:path";
import { bunBuildInfo } from "../buildInfo.ts";
import type { RunnerConfig, ProviderRuntimeConfig } from "../config/env.ts";
import { codexAppIntegrationStatus } from "../config/codexServer.ts";
import { buildStaticConnectorDiagnostics } from "../integrations/connectorDiagnostics.ts";
import { feishuConnectorStatus } from "../integrations/feishu.ts";
import type { FeishuReceiverStatus } from "../integrations/feishuReceiver.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { ExecutorCapability } from "../providers/types.ts";
import type { ProviderRegistry } from "../providers/core/registry.ts";
import { statusFromRegistry } from "../providers/core/status.ts";
import { CLAUDE_AGENT_SDK_VERSION, resolveClaudeSdkExecutable } from "../providers/claude/provider.ts";
import { claudeAuthenticationStatus } from "../providers/claude/auth.ts";
import { inspectClaudeCliAuth } from "../providers/claude/cliProvider.ts";
import { codexAppServerRpcTimeoutMs } from "../providers/codex/jsonRpc.ts";
import { projectLoopMaxParallelProjects, runningProjectLoopCount } from "../runner/projectLoopManager.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { eventProjectionStatusForRead } from "../db/repositories/compactEventSummaryProjection.ts";
import { runProgressProjectionStatus } from "../db/repositories/runProgress.ts";
import { isSensitiveFieldName } from "../security/redactionRegistry.ts";
import { buildRuntimeObservability } from "../observability/runtimeObservability.ts";
import { PROCESS_GROUP_MEMORY_CONTRACT } from "../observability/processGroupMemory.ts";

type SystemStatusContext = {
  authEnabled: boolean;
  config: RunnerConfig;
  database: RunnerDatabase;
  feishuReceiverStatus?: () => FeishuReceiverStatus;
  processGroupMemory?: { snapshot(): Record<string, unknown> };
  projectionWorker?: { snapshot(): Record<string, unknown> };
  /** P4：registry 装配后由 registry.list() 投影 providers，替代手写 codex/claude switch */
  providersRegistry?: ProviderRegistry;
  role?: "all" | "core";
  startedAt: Date;
  webhookSigningSecret?: string;
};

type CheckStatus = { ok: boolean; error?: string };
const commandVersionCache = new Map<string, string>();

export function buildSystemStatus(context: SystemStatusContext): Record<string, unknown> {
  const startedAt = performance.now();
  const timings: Record<string, number> = {};
  const phase = <T>(name: string, operation: () => T): T => {
    const started = performance.now();
    try {
      return operation();
    } finally {
      timings[name] = roundedMs(performance.now() - started);
    }
  };
  const providers = phase("providers", () => providerStatus(context.config, context.providersRegistry));
  const receiver = phase("receiver", () => context.feishuReceiverStatus?.());
  const connectorHealth = phase("connector_health", () => buildStaticConnectorDiagnostics({
    config: context.config,
    database: context.database,
    feishuReceiverStatus: receiver,
    webhookSigningSecret: context.webhookSigningSecret
  }));
  const eventProjection = phase("event_projection", () => eventProjectionStatusForRead(context.database));
  const runProgressProjection = phase("run_progress_projection", () => runProgressProjectionStatus(context.database));
  const observability = phase("observability", () => buildRuntimeObservability(context.database));
  const status = {
    service: phase("service", () => serviceStatus(context.startedAt, context.role)),
    db: phase("database", () => databaseStatus(context.database)),
    auth: { enabled: context.authEnabled },
    config: configStatus(context),
    security: { warnings: securityWarnings(context.config.addr, context.authEnabled) },
    codex: phase("codex", () => codexStatus(context.config)),
    providers,
    connectors: phase("connectors", () => connectorStatus(context.config, receiver)),
    connector_health: connectorHealth,
    event_projection: eventProjection,
    run_progress_projection: runProgressProjection,
    runner: phase("runner", () => runnerStatus(context.database)),
    observability,
    process_group_memory: phase("process_group_memory", () => (
      context.processGroupMemory?.snapshot() ?? unavailableProcessGroupMemory()
    )),
    background_projection: context.projectionWorker?.snapshot() ?? { status: "unavailable" }
  };
  const health = phase("health", () => systemHealth({
    ...status,
    required_provider_ids: requiredProviderIDs(context.database)
  }));
  const durationMs = performance.now() - startedAt;
  if (durationMs >= 500) {
    console.warn(JSON.stringify({
      event: "runner.system_status_slow",
      duration_ms: roundedMs(durationMs),
      phases_ms: timings
    }));
  }
  return { ...status, health };
}

/** Lightweight authenticated liveness payload for the Web shell. */
export function buildCompactSystemStatus(context: SystemStatusContext): Record<string, unknown> {
  const command = redactSensitiveText(context.config.providers.codex?.command ?? "");
  return {
    service: serviceStatus(context.startedAt, context.role),
    db: databaseStatus(context.database),
    auth: { enabled: context.authEnabled },
    config: configStatus(context),
    codex: { command, command_ok: command.trim() !== "" },
    providers: providerStatus(context.config, context.providersRegistry),
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
    health: status.health,
    db: { ...status.db, path: status.config.db_path, path_visible: status.db.ok },
    runner: status.runner,
    projects: [],
    providers: status.providers.map(doctorProvider),
    connectors: status.connectors,
    observability: status.observability,
    process_group_memory: status.process_group_memory,
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

function serviceStatus(startedAt: Date, role: "all" | "core" = "all"): Record<string, unknown> {
  const build = bunBuildInfo();
  const memory = process.memoryUsage();
  return {
    alive: true,
    name: "xuanwu backend-ts",
    runtime: "bun",
    role,
    bun_version: build.bun_version,
    version: build.version,
    build,
    memory: {
      array_buffers_bytes: memory.arrayBuffers,
      external_bytes: memory.external,
      heap_total_bytes: memory.heapTotal,
      heap_used_bytes: memory.heapUsed,
      rss_bytes: memory.rss
    },
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
    role: context.role ?? "all",
    db_path: summarizeRuntimePath(context.database.path, context.config.stateDir),
    auth_enabled: context.authEnabled,
    origin_policy: "local_only",
    codex_server_mode: context.config.codexServer.mode,
    max_parallel_projects: context.config.runner.maxParallelProjects,
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
  const app = codexAppIntegrationStatus(config.codexServer.appCommand);
  return {
    command,
    command_ok: command.trim() !== "",
    server_mode: config.codexServer.mode,
    cli_command: redactSensitiveText(config.codexServer.cliCommand),
    app_command: redactSensitiveText(config.codexServer.appCommand),
    app,
    capability_summary: capabilities.join(","),
    capabilities,
    app_server: "not_checked",
    model_list: "not_checked"
  };
}

export type ProviderStatus = {
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
  mode?: string;
  ready?: boolean;
  readiness_reason?: string;
  sdk?: Record<string, unknown>;
  api_base_url_summary?: string;
  api_key_configured?: boolean;
  auth_configured?: boolean;
  auth_mode?: string;
  auth_source?: string;
  local_cli?: Record<string, unknown>;
  platform_profile?: Record<string, unknown>;
  /** P4 registry 投影附加字段 */
  registry_state?: string;
  support_level?: string;
  runtime_version?: string;
  failure?: { category: string; message: string };
};

export function providerStatus(config: RunnerConfig, registry?: ProviderRegistry): ProviderStatus[] {
  if (registry) return statusFromRegistry(registry.list()).map(registryStatusEntry);
  const out = [];
  const codex = config.providers.codex;
  if (codex) out.push(providerEntry({
    capabilities: codexCapabilities(),
    config: codex,
    id: "codex",
    label: "Codex",
    settingsMode: `runner_settings:${config.codexServer.mode}`
  }));
  const claude = config.providers.claude;
  if (claude) out.push(claudeProviderEntry(claude));
  return out;
}

/** P4：ProviderStatusEntry → 兼容 ProviderStatus 形状（doctor/UI 无需修改）。 */
function registryStatusEntry(entry: ReturnType<typeof statusFromRegistry>[number]): ProviderStatus {
  return {
    id: entry.id,
    label: entry.label,
    role: "executor",
    status: entry.state,
    available: entry.available,
    enabled: entry.enabled,
    capabilities: [...entry.capabilities],
    command: "",
    cli: { available: entry.available, mode: "provider_registry" },
    cwd_configured: false,
    env_keys: [],
    secrets: {},
    settings_mode: "provider_registry",
    timeout_ms: 0,
    registry_state: entry.state,
    ready: entry.ready,
    support_level: entry.supportLevel,
    ...(entry.authSource === undefined ? {} : { auth_source: entry.authSource }),
    ...(entry.runtimeVersion === undefined ? {} : { runtime_version: entry.runtimeVersion }),
    ...(entry.failure === undefined ? {} : { failure: entry.failure })
  };
}

function claudeProviderEntry(config: ProviderRuntimeConfig) {
  const mode = config.mode ?? "sdk";
  const executableReady = resolveClaudeSdkExecutable() !== "";
  if (mode === "cli-fallback") {
    const base = providerEntry({
        capabilities: claudeCapabilities(),
        config,
        defaultModel: config.model ?? "",
        id: "claude",
        label: "Claude Code",
        settingsMode: config.authMode === "local-cli" ? "local_claude_cli_login" : "runner_env_to_claude_cli"
      });
    const authMode = config.authMode ?? "local-cli";
    const authentication = claudeAuthenticationStatus(config);
    const localCli = authMode === "local-cli" ? inspectClaudeCliAuth(config) : undefined;
    const authConfigured = localCli ? localCli.logged_in : authentication.configured;
    const ready = base.cli.available && authConfigured;
    return {
      ...base,
      status: ready ? "available" : base.cli.available ? "configuration_required" : "missing",
      available: ready,
      api_base_url_summary: safeApiBaseSummary(config.apiBaseUrl ?? config.env.ANTHROPIC_BASE_URL ?? ""),
      api_key_configured: hasConfiguredApiKey(config.env, "claude"),
      auth_configured: authConfigured,
      auth_mode: authMode,
      auth_source: authMode === "local-cli" ? "local_cli" : authentication.source,
      ...(localCli ? { local_cli: localCli } : {}),
      mode,
      ready,
      ...(!ready && base.cli.available ? { readiness_reason: authMode === "local-cli"
        ? "Claude CLI local login is unavailable"
        : authentication.reason || "Claude CLI environment authentication is unavailable" } : {}),
      sdk: { executable_ready: executableReady, installed: true, ready: false, version: CLAUDE_AGENT_SDK_VERSION }
    };
  }
  const apiKeyConfigured = hasConfiguredApiKey(config.env, "claude");
  const authentication = claudeAuthenticationStatus(config);
  const ready = authentication.configured && executableReady;
  const readinessReason = !authentication.configured
    ? authentication.reason || "Claude SDK authentication is not configured"
    : !executableReady
      ? "Claude SDK native executable is unavailable"
      : "";
  return {
    id: "claude",
    label: "Claude Agent SDK",
    role: "executor",
    status: ready ? "available" : "configuration_required",
    available: ready,
    enabled: true,
    capabilities: claudeCapabilities(),
    command: "bundled:@anthropic-ai/claude-agent-sdk",
    cli: { available: false, mode: "not_used" },
    cwd_configured: config.cwd.trim() !== "",
    default_model: redactSensitiveText(config.model ?? ""),
    env_keys: diagnosticEnvKeys(config.env),
    secrets: { api_key: { configured: apiKeyConfigured } },
    settings_mode: authentication.mode === "platform-profile"
      ? "anthropic_platform_profile"
      : "runner_env_to_anthropic_sdk",
    timeout_ms: config.timeoutMs,
    api_base_url_summary: safeApiBaseSummary(config.apiBaseUrl ?? config.env.ANTHROPIC_BASE_URL ?? ""),
    api_key_configured: apiKeyConfigured,
    auth_configured: authentication.configured,
    auth_mode: authentication.mode,
    auth_source: authentication.source,
    ...(authentication.platform_profile ? { platform_profile: authentication.platform_profile } : {}),
    mode,
    ready,
    ...(readinessReason ? { readiness_reason: readinessReason } : {}),
    sdk: { executable_ready: executableReady, installed: true, ready, version: CLAUDE_AGENT_SDK_VERSION }
  };
}

/** Resolve slow provider CLI versions before the HTTP listener is exposed. */
export function primeProviderStatus(config: RunnerConfig): void {
  providerStatus(config);
}

function connectorStatus(config: RunnerConfig, receiver?: FeishuReceiverStatus): Array<Record<string, unknown>> {
  const status = feishuConnectorStatus(config.integrations.feishu);
  return receiver ? [{ ...status, runtime: receiver }] : [status];
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
    timeout_ms: input.config.timeoutMs,
    ...(input.id === "codex" ? { effective_rpc_timeout_ms: codexAppServerRpcTimeoutMs(input.config.timeoutMs) } : {})
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
  const key = commandVersionCacheKey(path, env);
  if (commandVersionCache.has(key)) return commandVersionCache.get(key) ?? "";
  try {
    const result = Bun.spawnSync([path, "--version"], { env: { ...Bun.env, ...env }, stderr: "pipe", stdout: "pipe" });
    const value = result.exitCode === 0
      ? redactSensitiveText(new TextDecoder().decode(result.stdout).trim())
      : "";
    commandVersionCache.set(key, value);
    return value;
  } catch {
    commandVersionCache.set(key, "");
    return "";
  }
}

function commandVersionCacheKey(path: string, env: Record<string, string>): string {
  let modifiedAt = 0;
  try {
    modifiedAt = statSync(path).mtimeMs;
  } catch {
    // Executable availability is reported separately; a missing stat simply
    // gets a short-lived empty-version cache entry.
  }
  return `${path}\0${modifiedAt}\0${env.PATH ?? ""}`;
}

function codexCapabilities(): ExecutorCapability[] {
  return ["issue_execution", "sessions", "resume_session", "interrupt", "approvals", "model_list"];
}

function claudeCapabilities(): ExecutorCapability[] {
  return ["issue_execution", "sessions", "resume_session", "interrupt"];
}

function diagnosticEnvKeys(env: Record<string, string>): string[] {
  return Object.keys(env).filter((key) => !isSensitiveFieldName(key)).sort();
}

function hasConfiguredApiKey(env: Record<string, string>, provider: string): boolean {
  const keys = provider === "claude"
    ? ["ANTHROPIC_API_KEY"]
    : ["CODEX_API_KEY", "OPENAI_API_KEY"];
  return keys.some((key) => (env[key] ?? (provider === "claude" ? "" : Bun.env[key]) ?? "").trim() !== "");
}

function safeApiBaseSummary(value: string): string {
  const text = value.trim();
  if (text === "") return "default_anthropic_endpoint";
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "configured_invalid";
    const hasPrivatePath = url.pathname.replace(/\/+$/, "") !== "";
    return `${url.protocol}//${url.host}${hasPrivatePath ? "/…" : "/"}`;
  } catch {
    return "configured_invalid";
  }
}

function runnerStatus(database: RunnerDatabase): Record<string, number> {
  return {
    auto_run_projects: countRows(database, "select count(*) as count from projects where auto_run=1"),
    running_loops: runningProjectLoopCount(),
    max_parallel_projects: projectLoopMaxParallelProjects(),
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
  connector_health: Array<Record<string, unknown>>;
  event_projection: Record<string, unknown>;
  health: Record<string, unknown>;
  observability: Record<string, unknown>;
  process_group_memory: Record<string, unknown>;
  providers: ProviderStatus[];
  run_progress_projection: Record<string, unknown>;
  runner: Record<string, number>;
  security: Record<string, unknown>;
  service: Record<string, unknown>;
};

function systemHealth(status: {
  connector_health: Array<Record<string, unknown>>;
  db: CheckStatus;
  event_projection: Record<string, unknown>;
  observability: Record<string, unknown>;
  process_group_memory: Record<string, unknown>;
  providers: ProviderStatus[];
  required_provider_ids: Set<string>;
  run_progress_projection: Record<string, unknown>;
  security: { warnings: Array<Record<string, string>> };
}): Record<string, unknown> {
  const reasons: Array<Record<string, unknown>> = [];
  if (!status.db.ok) reasons.push(healthReason("database_unavailable", "critical", "db", "database query failed"));
  for (const warning of arrayObjects(status.security.warnings)) {
    reasons.push(healthReason(String(warning.code || "security_warning"), "warning", "security", String(warning.message || "security warning")));
  }
  for (const provider of status.providers.filter((item) => status.required_provider_ids.has(item.id) && !item.available)) {
    reasons.push(healthReason("provider_unavailable", "warning", `provider:${provider.id}`, `${provider.label} is unavailable`));
  }
  for (const connector of status.connector_health) {
    const health = object(connector.health);
    const state = String(health.state ?? connector.state ?? "");
    if (["failed", "degraded", "disconnected", "rate_limited", "revoked"].includes(state)) {
      reasons.push(healthReason(
        "connector_unhealthy",
        state === "failed" || state === "revoked" ? "critical" : "warning",
        `connector:${String(connector.id ?? "unknown")}`,
        state
      ));
    }
  }
  if (status.event_projection.status === "lagging") {
    reasons.push(healthReason("event_projection_lagging", "warning", "event_summary_projection", `${Number(status.event_projection.lag_rows ?? 0)} rows pending`));
  }
  if (Number(status.run_progress_projection.stalled_runs ?? 0) > 0) {
    reasons.push(healthReason("run_progress_stalled", "warning", "run_progress_projection", `${Number(status.run_progress_projection.stalled_runs)} runs stalled`));
  }
  const healthSignals = object(status.observability.health_signals);
  for (const signal of arrayObjects(healthSignals.reasons)) {
    reasons.push(healthReason(String(signal.code ?? "observability_degraded"), "warning", String(signal.source_ref ?? "observability"), `${Number(signal.count ?? 0)} affected`));
  }
  const memoryBudget = object(status.process_group_memory.budget);
  if (memoryBudget.status === "hard_exceeded" || memoryBudget.status === "soft_exceeded") {
    reasons.push(healthReason(
      "process_group_memory_budget_exceeded",
      memoryBudget.status === "hard_exceeded" ? "critical" : "warning",
      "process_group_memory",
      String(memoryBudget.status)
    ));
  }
  const state = reasons.some((item) => item.severity === "critical") ? "failed" : reasons.length > 0 ? "degraded" : "healthy";
  return { state, reasons };
}

function unavailableProcessGroupMemory(): Record<string, unknown> {
  return {
    contract: PROCESS_GROUP_MEMORY_CONTRACT,
    sampled_at: "",
    freshness: { age_ms: null, stale_after_ms: 5_000, status: "unavailable" },
    phase: "unknown",
    aggregate: { footprint_bytes: null, process_count: 0, rss_bytes: null, rss_p95_bytes: null },
    roles: [],
    top_by_rss: [],
    recently_exited: [],
    budget: { auto_restart: false, status: "unavailable" }
  };
}

function healthReason(code: string, severity: "critical" | "warning", sourceRef: string, message: string): Record<string, unknown> {
  return { code, severity, source_ref: sourceRef, message: redactSensitiveText(message) };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayObjects(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(object) : [];
}

function roundedMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function requiredProviderIDs(database: RunnerDatabase): Set<string> {
  return new Set(database.sqlite.query<{ provider: string }, []>(`
    select provider from projects where trim(provider)<>''
    union
    select provider from issue_runs where ended_at='' and trim(provider)<>''
  `).all().map((row) => String(row.provider)));
}
