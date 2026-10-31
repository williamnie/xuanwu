import { basename, isAbsolute, relative } from "node:path";
import { bunBuildInfo } from "../../buildInfo.ts";
import type { RunnerConfig, ProviderRuntimeConfig } from "../../config/env.ts";
import { codexAppIntegrationStatus } from "../../config/codexServer.ts";
import { feishuConnectorStatus } from "../../integrations/feishu/feishu.ts";
import type { FeishuReceiverStatus } from "../../integrations/feishu/feishuReceiver.ts";
import type { RunnerDatabase } from "../../db/database.ts";
import type { ProviderRegistry } from "../../providers/core/registry.ts";
import { statusFromRegistry } from "../../providers/core/status.ts";
import { CLAUDE_AGENT_SDK_VERSION, resolveClaudeSdkExecutable } from "../../providers/claude/provider.ts";
import { claudeAuthenticationStatus } from "../../providers/claude/auth.ts";
import { inspectClaudeCliAuth } from "../../providers/claude/cliProvider.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import type { CheckStatus, SystemStatusContext, ProviderStatus } from "./systemStatus.model.ts";
import { codexCapabilities, registryStatusEntry, providerEntry, claudeCapabilities, safeApiBaseSummary, hasConfiguredApiKey, diagnosticEnvKeys } from "./systemStatus.providerEntry.ts";

export function summarizeRuntimePath(path: string, stateDir: string): string {
  const cleanPath = path.trim();
  const cleanStateDir = stateDir.trim();
  if (cleanPath === "") return "";
  if (cleanStateDir !== "") return summarizeRelativePath(cleanPath, cleanStateDir);
  return `<${basename(cleanPath) || "path"}>`;
}

export function serviceStatus(startedAt: Date, role: "all" | "core" = "all"): Record<string, unknown> {
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

export function databaseStatus(database: RunnerDatabase): CheckStatus {
  try {
    database.sqlite.query("select 1 as ok").get();
    return { ok: true };
  } catch {
    return { ok: false, error: "database query failed" };
  }
}

export function configStatus(context: SystemStatusContext): Record<string, unknown> {
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

export function securityWarnings(addr: string, authEnabled: boolean): Array<Record<string, string>> {
  const warnings: Array<Record<string, string>> = [];
  if (bindsAllInterfaces(addr)) {
    warnings.push({ code: "bind_all_interfaces", message: "service listens on all interfaces" });
  }
  if (!authEnabled) {
    warnings.push({ code: "auth_disabled", message: "API bearer token auth is disabled" });
  }
  return warnings;
}

export function codexStatus(config: RunnerConfig): Record<string, unknown> {
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

export function claudeProviderEntry(config: ProviderRuntimeConfig) {
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

export function connectorStatus(config: RunnerConfig, receiver?: FeishuReceiverStatus): Array<Record<string, unknown>> {
  const status = feishuConnectorStatus(config.integrations.feishu);
  return receiver ? [{ ...status, runtime: receiver }] : [status];
}

export function summarizeRelativePath(path: string, stateDir: string): string {
  const relativePath = relative(stateDir, path);
  if (relativePath === "") return "<stateDir>";
  if (isSafeRelativePath(relativePath)) return `<stateDir>/${relativePath.replaceAll("\\", "/")}`;
  return `<${basename(path) || "path"}>`;
}

export function isSafeRelativePath(path: string): boolean {
  return !path.startsWith("..") && !isAbsolute(path);
}

export function bindsAllInterfaces(addr: string): boolean {
  const clean = addr.trim();
  return clean.startsWith(":") || clean.startsWith("0.0.0.0:") || clean.startsWith("[::]:");
}
