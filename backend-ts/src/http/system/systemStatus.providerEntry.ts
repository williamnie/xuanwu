import { statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import type { ExecutorCapability } from "../../providers/types.ts";
import { statusFromRegistry } from "../../providers/core/status.ts";
import { codexAppServerRpcTimeoutMs } from "../../providers/codex/jsonRpc.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import { isSensitiveFieldName } from "../../security/redactionRegistry.ts";
import type { ProviderStatus } from "./systemStatus.model.ts";

export const commandVersionCache = new Map<string, string>();

/** P4：ProviderStatusEntry → 兼容 ProviderStatus 形状（doctor/UI 无需修改）。 */
export function registryStatusEntry(entry: ReturnType<typeof statusFromRegistry>[number]): ProviderStatus {
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

export function providerEntry(input: {
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

export function cliStatus(config: ProviderRuntimeConfig): Record<string, unknown> & { available: boolean } {
  const command = redactSensitiveText(config.command.trim());
  if (command === "") return { command: "", available: false, error: "command is empty" };
  const binary = firstCommandPart(command);
  const path = findExecutable(binary, config.env);
  const base = { command, available: path !== "" };
  if (path === "") return { ...base, error: `exec: "${binary}" not found in PATH` };
  const version = commandVersion(path, config.env);
  return { ...base, path: redactSensitiveText(path), ...(version === "" ? {} : { version }) };
}

export function firstCommandPart(command: string): string {
  const match = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/)?.[0] ?? "";
  return unquoteArg(match);
}

export function unquoteArg(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

export function findExecutable(command: string, env: Record<string, string>): string {
  if (command === "") return "";
  if (command.includes("/")) return isExecutable(command) ? command : "";
  const overridePath = env.PATH;
  if (overridePath !== undefined) return findInPath(command, overridePath);
  return Bun.which(command) ?? findInPath(command, Bun.env.PATH ?? "");
}

export function findInPath(command: string, pathEnv: string): string {
  for (const dir of pathEnv.split(delimiter)) {
    const candidate = join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  return "";
}

export function isExecutable(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function commandVersion(path: string, env: Record<string, string>): string {
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

export function commandVersionCacheKey(path: string, env: Record<string, string>): string {
  let modifiedAt = 0;
  try {
    modifiedAt = statSync(path).mtimeMs;
  } catch {
    // Executable availability is reported separately; a missing stat simply
    // gets a short-lived empty-version cache entry.
  }
  return `${path}\0${modifiedAt}\0${env.PATH ?? ""}`;
}

export function codexCapabilities(): ExecutorCapability[] {
  return ["issue_execution", "sessions", "resume_session", "interrupt", "approvals", "model_list"];
}

export function claudeCapabilities(): ExecutorCapability[] {
  return ["issue_execution", "sessions", "resume_session", "interrupt"];
}

export function diagnosticEnvKeys(env: Record<string, string>): string[] {
  return Object.keys(env).filter((key) => !isSensitiveFieldName(key)).sort();
}

export function hasConfiguredApiKey(env: Record<string, string>, provider: string): boolean {
  const keys = provider === "claude"
    ? ["ANTHROPIC_API_KEY"]
    : ["CODEX_API_KEY", "OPENAI_API_KEY"];
  return keys.some((key) => (env[key] ?? (provider === "claude" ? "" : Bun.env[key]) ?? "").trim() !== "");
}

export function safeApiBaseSummary(value: string): string {
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

export function roundedMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}
