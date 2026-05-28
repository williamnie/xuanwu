import { basename, isAbsolute, relative } from "node:path";
import type { RunnerConfig } from "../config/env.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { redactSensitiveText } from "../util/redact.ts";

type SystemStatusContext = {
  authEnabled: boolean;
  config: RunnerConfig;
  database: RunnerDatabase;
  startedAt: Date;
};

type CheckStatus = { ok: boolean; error?: string };

export function buildSystemStatus(context: SystemStatusContext): Record<string, unknown> {
  return {
    service: serviceStatus(context.startedAt),
    db: databaseStatus(context.database),
    auth: { enabled: context.authEnabled },
    config: configStatus(context),
    security: { warnings: securityWarnings(context.config.addr, context.authEnabled) },
    codex: codexStatus(context.config),
    providers: providerStatus(context.config),
    runner: runnerStatus()
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
  return {
    alive: true,
    name: "codex-issue-runner backend-ts",
    runtime: "bun",
    bun_version: Bun.version,
    version: "0.0.0-dev",
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
    web_mode: "api_only"
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
  const command = redactSensitiveText(config.providers.codex?.command ?? "");
  return { command, command_ok: command.trim() !== "", app_server: "not_checked", model_list: "not_checked" };
}

function providerStatus(config: RunnerConfig): Array<Record<string, unknown>> {
  const codex = config.providers.codex;
  if (!codex) return [];
  return [{
    id: "codex",
    role: "executor",
    capabilities: ["issue_execution", "sessions", "resume_session", "interrupt", "approvals", "model_list"],
    command: redactSensitiveText(codex.command),
    cwd_configured: codex.cwd.trim() !== "",
    env_keys: diagnosticEnvKeys(codex.env),
    timeout_ms: codex.timeoutMs
  }];
}

function diagnosticEnvKeys(env: Record<string, string>): string[] {
  return Object.keys(env).filter((key) => !isSensitiveEnvKey(key)).sort();
}

function isSensitiveEnvKey(key: string): boolean {
  return /(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|ACCESS[_-]?KEY)/i.test(key);
}

function runnerStatus(): Record<string, number> {
  return {
    auto_run_projects: 0,
    running_loops: 0,
    held_projects: 0,
    in_progress_issues: 0,
    running_issues: 0,
    running_sessions: 0
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
