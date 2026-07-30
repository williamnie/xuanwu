import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ProviderRuntimeConfig } from "../../config/env.ts";

export const CLAUDE_ENVIRONMENT_AUTH_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN"
] as const;

export type ClaudeAuthenticationStatus = {
  configured: boolean;
  mode: "environment" | "local-cli" | "platform-profile";
  source: "api_key" | "auth_token" | "claude_oauth_token" | "local_cli" | "none" | "platform_profile";
  reason?: string;
  platform_profile?: {
    auth_type: string;
    config_dir: string;
    credentials_file_ready: boolean;
    profile: string;
  };
};

type ProfileDocument = {
  authentication?: {
    credentials_path?: string;
    federation_rule_id?: string;
    identity_token?: { path?: string; source?: string };
    service_account_id?: string;
    type?: string;
  };
  organization_id?: string;
};

export function claudeAuthenticationStatus(config: ProviderRuntimeConfig): ClaudeAuthenticationStatus {
  const mode = config.authMode ?? (config.mode === "cli-fallback" ? "local-cli" : "environment");
  if (mode === "local-cli") {
    return { configured: false, mode, source: "local_cli", reason: "Claude CLI login has not been checked" };
  }
  if (mode === "platform-profile") return platformProfileStatus(config);
  return environmentAuthenticationStatus(config.env);
}

export function claudeProcessEnvironment(
  config: ProviderRuntimeConfig,
  parentEnvironment: Record<string, string | undefined> = Bun.env
): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = { ...parentEnvironment };
  const merged = { ...environment, ...config.env };
  if (config.authMode === "local-cli" || config.authMode === "platform-profile") {
    for (const key of CLAUDE_ENVIRONMENT_AUTH_KEYS) delete merged[key];
  }
  return merged;
}

export function environmentAuthenticationStatus(env: Record<string, string>): ClaudeAuthenticationStatus {
  if (clean(env.ANTHROPIC_API_KEY)) return { configured: true, mode: "environment", source: "api_key" };
  if (clean(env.ANTHROPIC_AUTH_TOKEN)) return { configured: true, mode: "environment", source: "auth_token" };
  if (clean(env.CLAUDE_CODE_OAUTH_TOKEN)) return { configured: true, mode: "environment", source: "claude_oauth_token" };
  return { configured: false, mode: "environment", source: "none", reason: "Claude SDK environment authentication is not configured" };
}

function platformProfileStatus(config: ProviderRuntimeConfig): ClaudeAuthenticationStatus {
  const environment = claudeProcessEnvironment(config);
  const configDir = clean(config.platformConfigDir)
    || clean(environment.ANTHROPIC_CONFIG_DIR)
    || defaultAnthropicConfigDir(environment);
  if (!configDir) return missingProfile("Anthropic platform profile config directory is unavailable");
  const profile = resolveProfileName(config.platformProfile, environment, configDir);
  if (!isSafeProfileName(profile)) return missingProfile("Anthropic platform profile name is invalid", profile, configDir);
  const profilePath = join(configDir, "configs", `${profile}.json`);
  const document = readProfile(profilePath);
  if (!document) return missingProfile("Anthropic platform profile config is missing or invalid", profile, configDir);
  const authType = clean(document.authentication?.type);
  if (authType === "user_oauth") {
    const configuredPath = clean(document.authentication?.credentials_path);
    const credentialsPath = configuredPath
      ? (isAbsolute(configuredPath) ? configuredPath : join(configDir, configuredPath))
      : join(configDir, "credentials", `${profile}.json`);
    const credentialsReady = privateRegularFile(credentialsPath);
    return {
      configured: credentialsReady,
      mode: "platform-profile",
      source: "platform_profile",
      ...(credentialsReady ? {} : { reason: "Anthropic platform OAuth credentials file is missing or not private" }),
      platform_profile: profileSummary(authType, configDir, profile, credentialsReady)
    };
  }
  if (authType === "oidc_federation") {
    const identityPath = clean(document.authentication?.identity_token?.path)
      || clean(environment.ANTHROPIC_IDENTITY_TOKEN_FILE);
    const inlineIdentity = clean(environment.ANTHROPIC_IDENTITY_TOKEN);
    const identityReady = inlineIdentity !== "" || (identityPath !== "" && privateRegularFile(identityPath));
    const fieldsReady = clean(document.authentication?.federation_rule_id) !== ""
      && clean(document.authentication?.service_account_id) !== ""
      && clean(document.organization_id) !== "";
    const configured = identityReady && fieldsReady;
    return {
      configured,
      mode: "platform-profile",
      source: "platform_profile",
      ...(configured ? {} : { reason: "Anthropic platform federation profile is incomplete" }),
      platform_profile: profileSummary(authType, configDir, profile, identityReady)
    };
  }
  return {
    configured: false,
    mode: "platform-profile",
    source: "platform_profile",
    reason: "Anthropic platform profile authentication type is unsupported",
    platform_profile: profileSummary(authType || "unknown", configDir, profile, false)
  };
}

function resolveProfileName(configured: string | undefined, environment: Record<string, string | undefined>, configDir: string): string {
  const explicit = clean(configured) || clean(environment.ANTHROPIC_PROFILE);
  if (explicit) return explicit;
  try {
    return clean(readFileSync(join(configDir, "active_config"), "utf8")) || "default";
  } catch {
    return "default";
  }
}

function readProfile(path: string): ProfileDocument | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as ProfileDocument : undefined;
  } catch {
    return undefined;
  }
}

function privateRegularFile(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && (process.platform === "win32" || (stat.mode & 0o077) === 0);
  } catch {
    return false;
  }
}

function defaultAnthropicConfigDir(environment: Record<string, string | undefined>): string {
  if (process.platform === "win32") return clean(environment.APPDATA) ? join(clean(environment.APPDATA), "Anthropic") : "";
  const base = clean(environment.XDG_CONFIG_HOME) || (clean(environment.HOME) ? join(clean(environment.HOME), ".config") : "");
  return base ? join(base, "anthropic") : "";
}

function isSafeProfileName(value: string): boolean {
  return value !== "." && value !== ".." && /^[A-Za-z0-9_.-]+$/.test(value);
}

function profileSummary(authType: string, configDir: string, profile: string, credentialsReady: boolean) {
  return {
    auth_type: authType,
    config_dir: summarizeConfigDir(configDir),
    credentials_file_ready: credentialsReady,
    profile
  };
}

function missingProfile(reason: string, profile = "", configDir = ""): ClaudeAuthenticationStatus {
  return {
    configured: false,
    mode: "platform-profile",
    source: "platform_profile",
    reason,
    ...(profile || configDir ? { platform_profile: profileSummary("unknown", configDir, profile || "default", false) } : {})
  };
}

function summarizeConfigDir(configDir: string): string {
  const home = clean(Bun.env.HOME);
  if (home && configDir === join(home, ".config", "anthropic")) return "<home>/.config/anthropic";
  return configDir ? "<configured>" : "";
}

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}
