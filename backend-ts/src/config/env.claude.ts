import { readFileSync } from "node:fs";
import { registerSecretForRedaction } from "../security/redactionRegistry.ts";
import type { ProviderRuntimeOverrides, ProviderRuntimeConfig } from "./env.types.ts";
import { parseEnvOverrides, cleanValue, buildProviderRuntimeConfig, parseBoolean } from "./env.values.ts";

export const DEFAULT_CLAUDE_COMMAND = "claude";

export function buildClaudeRuntimeConfig(overrides: ProviderRuntimeOverrides): ProviderRuntimeConfig {
  const legacyEnv = parseEnvOverrides(cleanValue(overrides.claudeEnv) ?? "");
  const apiPath = normalizeClaudeApiPath(overrides.claudeApiPath);
  const configuredBase = cleanValue(overrides.claudeApiBaseUrl) ?? cleanValue(legacyEnv.ANTHROPIC_BASE_URL) ?? "";
  const apiBaseUrl = joinClaudeApiBase(configuredBase, apiPath);
  const apiKey = cleanValue(overrides.claudeApiKey)
    ?? readSecretFile(overrides.claudeApiKeyFile)
    ?? cleanValue(legacyEnv.ANTHROPIC_API_KEY)
    ?? "";
  const authToken = cleanValue(overrides.claudeAuthToken) ?? cleanValue(legacyEnv.ANTHROPIC_AUTH_TOKEN) ?? "";
  const oauthToken = cleanValue(overrides.claudeOauthToken) ?? cleanValue(legacyEnv.CLAUDE_CODE_OAUTH_TOKEN) ?? "";
  const platformConfigDir = cleanValue(overrides.claudePlatformConfigDir) ?? cleanValue(legacyEnv.ANTHROPIC_CONFIG_DIR) ?? "";
  const platformProfile = normalizeClaudePlatformProfile(
    cleanValue(overrides.claudePlatformProfile) ?? cleanValue(legacyEnv.ANTHROPIC_PROFILE) ?? ""
  );
  const environmentAuthConfigured = Boolean(apiKey || authToken || oauthToken);
  const mode = normalizeClaudeProviderMode(overrides.claudeMode);
  const authMode = normalizeClaudeAuthMode(overrides.claudeAuthMode, mode, environmentAuthConfigured);
  if (authMode !== "environment") {
    delete legacyEnv.ANTHROPIC_API_KEY;
    delete legacyEnv.ANTHROPIC_AUTH_TOKEN;
    delete legacyEnv.CLAUDE_CODE_OAUTH_TOKEN;
  }
  const env = {
    ...legacyEnv,
    ...(apiBaseUrl === "" ? {} : { ANTHROPIC_BASE_URL: apiBaseUrl }),
    ...(authMode === "environment" && apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
    ...(authMode === "environment" && authToken ? { ANTHROPIC_AUTH_TOKEN: authToken } : {}),
    ...(authMode === "environment" && oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken } : {}),
    ...(authMode === "platform-profile" && platformConfigDir ? { ANTHROPIC_CONFIG_DIR: platformConfigDir } : {}),
    ...(authMode === "platform-profile" && platformProfile ? { ANTHROPIC_PROFILE: platformProfile } : {})
  };
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const) {
    if (env[key]) registerSecretForRedaction(env[key]);
  }
  return {
    ...buildProviderRuntimeConfig({
      command: overrides.claudeCommand,
      cwd: overrides.claudeCwd,
      defaultCommand: DEFAULT_CLAUDE_COMMAND,
      env: "",
      timeoutMs: overrides.claudeTimeoutMs
    }),
    apiBaseUrl,
    apiPath,
    authMode,
    enabled: parseBoolean(overrides.claudeEnabled, true),
    env,
    mode,
    model: cleanValue(overrides.claudeModel) ?? "",
    platformConfigDir,
    platformProfile
  };
}

export function readSecretFile(pathValue: string | undefined): string | undefined {
  const path = cleanValue(pathValue);
  if (!path) return undefined;
  try {
    return cleanValue(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function normalizeClaudeProviderMode(value: string | undefined): "sdk" | "cli-fallback" | "herdr" {
  const configured = cleanValue(value)?.toLowerCase();
  const mode = configured ?? "sdk";
  if (mode === "sdk" || mode === "cli-fallback" || mode === "herdr") return mode;
  throw new Error(`XUANWU_CLAUDE_MODE must be sdk, cli-fallback or herdr, received ${mode}`);
}

export function normalizeClaudeAuthMode(
  value: string | undefined,
  providerMode: "sdk" | "cli-fallback" | "herdr",
  environmentAuthConfigured: boolean
): "environment" | "local-cli" | "platform-profile" {
  const configured = cleanValue(value)?.toLowerCase();
  const mode = configured ?? (!environmentAuthConfigured ? "local-cli" : "environment");
  if (mode !== "environment" && mode !== "local-cli" && mode !== "platform-profile") {
    throw new Error(`XUANWU_CLAUDE_AUTH_MODE must be environment, local-cli, or platform-profile, received ${mode}`);
  }
  if (providerMode === "herdr" && mode !== "local-cli") {
    throw new Error("herdr requires XUANWU_CLAUDE_AUTH_MODE=local-cli");
  }
  if (providerMode === "cli-fallback" && mode === "platform-profile") {
    throw new Error("XUANWU_CLAUDE_AUTH_MODE=platform-profile requires XUANWU_CLAUDE_MODE=sdk");
  }
  return mode;
}

export function normalizeClaudePlatformProfile(value: string): string {
  const profile = value.trim();
  if (profile === "") return "";
  if (profile === "." || profile === ".." || !/^[A-Za-z0-9_.-]+$/.test(profile)) {
    throw new Error("XUANWU_CLAUDE_PLATFORM_PROFILE must contain only letters, digits, dot, underscore, or hyphen");
  }
  return profile;
}

export function normalizeClaudeApiPath(value: string | undefined): string {
  const path = cleanValue(value) ?? "";
  if (path === "" || path === "/") return "";
  return `/${path.replace(/^\/+|\/+$/g, "")}`;
}

export function joinClaudeApiBase(baseValue: string, path: string): string {
  const base = baseValue.trim().replace(/\/+$/, "");
  if (base === "") return "";
  try {
    const parsed = new URL(base);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
  } catch {
    throw new Error("XUANWU_CLAUDE_API_BASE_URL must be an http(s) URL");
  }
  return `${base}${path}`;
}
