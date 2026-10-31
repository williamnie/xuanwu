import { defaultCodexAppCommand, defaultCodexAppEnv, defaultCodexCliCommand, normalizeCodexServerMode } from "./codexServer.ts";
import { registerSecretForRedaction } from "../security/redactionRegistry.ts";
import type { ProviderRuntimeOverrides, CodexServerConfig, ProviderRuntimeConfig, QoderAuthMode } from "./env.types.ts";
import { cleanValue, parseEnvOverrides, buildProviderRuntimeConfig, parseBoolean } from "./env.values.ts";

export const DEFAULT_PI_COMMAND = "pi";

export const DEFAULT_QODER_COMMAND = "qodercli";

export function buildCodexServerConfig(overrides: ProviderRuntimeOverrides): CodexServerConfig {
  const mode = normalizeCodexServerMode(overrides.codexServerMode);
  const cliCommand = normalizeCodexCommand(cleanValue(overrides.codexCommand) ?? defaultCodexCliCommand());
  const appCommand = normalizeCodexCommand(cleanValue(overrides.codexAppCommand) ?? defaultCodexAppCommand());
  return {
    appCommand,
    appEnv: mode === "app" ? defaultCodexAppEnv(appCommand) : {},
    cliCommand,
    mode
  };
}

export function buildCodexRuntimeConfig(
  overrides: ProviderRuntimeOverrides,
  server = buildCodexServerConfig(overrides)
): ProviderRuntimeConfig {
  const providerEnv = parseEnvOverrides(cleanValue(overrides.codexEnv) ?? "");
  const command = server.mode === "app" ? server.appCommand : server.cliCommand;
  const config = buildProviderRuntimeConfig({
    command,
    cwd: overrides.codexCwd,
    defaultCommand: server.cliCommand,
    env: "",
    timeoutMs: overrides.codexTimeoutMs
  });
  return {
    ...config,
    command: normalizeCodexCommand(config.command),
    enabled: parseBoolean(overrides.codexEnabled, true),
    env: server.mode === "app" ? { ...server.appEnv, ...providerEnv } : providerEnv
  };
}

export function buildPiRuntimeConfig(overrides: ProviderRuntimeOverrides): ProviderRuntimeConfig {
  return {
    ...buildProviderRuntimeConfig({
      command: overrides.piCommand,
      cwd: overrides.piCwd,
      defaultCommand: DEFAULT_PI_COMMAND,
      env: overrides.piEnv,
      timeoutMs: overrides.piTimeoutMs
    }),
    enabled: parseBoolean(overrides.piEnabled, true)
  };
}

export function buildQoderRuntimeConfig(overrides: ProviderRuntimeOverrides): ProviderRuntimeConfig {
  const authMode = normalizeQoderAuthMode(overrides.qoderAuthMode);
  const credentialRef = cleanValue(overrides.qoderCredentialRef) ?? "";
  const credential = cleanValue(overrides.qoderCredential) ?? "";
  const pat = cleanValue(overrides.qoderPat) ?? "";
  if (pat) registerSecretForRedaction(pat);
  if (credential) registerSecretForRedaction(credential);
  return {
    ...buildProviderRuntimeConfig({
      command: overrides.qoderCommand,
      cwd: undefined,
      defaultCommand: DEFAULT_QODER_COMMAND,
      env: "",
      timeoutMs: overrides.qoderTimeoutMs
    }),
    authMode,
    configDir: cleanValue(overrides.qoderConfigDir) ?? "",
    credential,
    credentialRef,
    enabled: parseBoolean(overrides.qoderEnabled, true),
    env: authMode === "pat-env" && pat ? { QODER_PERSONAL_ACCESS_TOKEN: pat } : {},
    mode: "sdk",
    model: cleanValue(overrides.qoderModel) ?? ""
  };
}

export function normalizeQoderAuthMode(value: string | undefined): QoderAuthMode {
  const mode = cleanValue(value)?.toLowerCase() ?? "local-cli";
  if (mode === "pat-env" || mode === "pat-secret-ref" || mode === "service-account-secret-ref" || mode === "local-cli") {
    return mode;
  }
  throw new Error(
    "XUANWU_QODER_AUTH_MODE must be pat-env, pat-secret-ref, service-account-secret-ref, or local-cli"
  );
}

export function normalizeCodexCommand(command: string): string {
  const parts = splitCommand(command);
  return parts.includes("app-server") ? command : `${command} app-server --listen stdio://`;
}

export function splitCommand(command: string): string[] {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(unquoteArg) ?? [];
}

export function unquoteArg(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
