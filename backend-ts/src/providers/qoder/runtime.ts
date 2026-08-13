import { statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import { detectProviderCommand } from "../core/command.ts";
import type { ProviderRuntimeStatus } from "../types.ts";
import { QODER_VERSION_PAIR } from "./version.ts";

const LOCAL_AUTH_MARKERS = ["oauth_creds.json", "qoder-credentials.json"] as const;

export type QoderAuthenticationStatus = {
  configured: boolean;
  mode: "pat-env" | "pat-secret-ref" | "service-account-secret-ref" | "local-cli";
  source: "environment" | "secret_ref" | "service_account_secret_ref" | "local_cli" | "none";
  reason?: string;
};

export type QoderRuntimeProbe = {
  installed: boolean;
  ready: boolean;
  reason?: string;
  status: ProviderRuntimeStatus;
};

export type QoderRuntimeProbeOptions = {
  inspectAuth?: (config: ProviderRuntimeConfig) => QoderAuthenticationStatus;
  inspectCli?: (command: string, env: Record<string, string>) => { installed: boolean; version?: string; reason?: string };
};

export type QoderAuthenticationProbeOptions = {
  inspectLocalLogin?: (config: ProviderRuntimeConfig) => boolean;
};

/** Offline-only readiness: executable/version and local configuration checks; never calls a model API. */
export function probeQoderRuntime(
  config: ProviderRuntimeConfig,
  options: QoderRuntimeProbeOptions = {}
): QoderRuntimeProbe {
  const authentication = (options.inspectAuth ?? qoderAuthenticationStatus)(config);
  const cli = (options.inspectCli ?? inspectQoderCli)(config.command, config.env);
  const cliReady = cli.installed && cli.version === QODER_VERSION_PAIR.cli;
  const ready = cliReady && authentication.configured;
  const reason = !cli.installed
    ? cli.reason ?? "Qoder CLI is unavailable"
    : !cliReady
      ? cli.reason ?? `Qoder CLI ${QODER_VERSION_PAIR.cli} is required`
      : !authentication.configured
        ? authentication.reason ?? "Qoder authentication is not configured"
        : undefined;
  return {
    installed: cli.installed,
    ready,
    ...(reason ? { reason } : {}),
    status: {
      active_sessions: 0,
      api_key_configured: authentication.configured && authentication.mode.startsWith("pat-"),
      auth_configured: authentication.configured,
      auth_mode: authentication.mode,
      auth_source: authentication.source,
      executable_ready: cliReady,
      mode: "sdk",
      ready,
      ...(reason ? { reason } : {}),
      platform_profile: {
        cli_version: cli.version ?? "",
        config_dir_scope: config.configDir ? "configured" : "default",
        protocol_status: cliReady ? "expected" : "unavailable",
        protocol_version: QODER_VERSION_PAIR.wireProtocol,
        sdk_ready: true,
        sdk_version: QODER_VERSION_PAIR.sdk
      },
      version: QODER_VERSION_PAIR.sdk
    }
  };
}

export function qoderAuthenticationStatus(
  config: ProviderRuntimeConfig,
  options: QoderAuthenticationProbeOptions = {}
): QoderAuthenticationStatus {
  const mode = normalizeAuthMode(config.authMode);
  if (mode === "pat-env") {
    const configured = clean(config.env.QODER_PERSONAL_ACCESS_TOKEN) !== "";
    return configured
      ? { configured: true, mode, source: "environment" }
      : { configured: false, mode, source: "none", reason: "QODER_PERSONAL_ACCESS_TOKEN is not configured" };
  }
  if (mode === "pat-secret-ref" || mode === "service-account-secret-ref") {
    const configured = clean(config.credentialRef) !== "" && clean(config.credential) !== "";
    const source = mode === "pat-secret-ref" ? "secret_ref" : "service_account_secret_ref";
    return configured
      ? { configured: true, mode, source }
      : { configured: false, mode, source, reason: "Qoder credential secret ref is missing or unresolved" };
  }
  const configDir = qoderConfigDir(config);
  const configured = LOCAL_AUTH_MARKERS.some((name) => privateNonemptyFile(join(configDir, name)))
    || (options.inspectLocalLogin ?? inspectQoderLocalCliLogin)(config);
  return configured
    ? { configured: true, mode, source: "local_cli" }
    : { configured: false, mode, source: "local_cli", reason: "Qoder local CLI login state was not found" };
}

/** Qoder may keep desktop/CLI login state outside ~/.qoder; `status` verifies it without a model request. */
function inspectQoderLocalCliLogin(config: ProviderRuntimeConfig): boolean {
  const detected = detectProviderCommand(config.command);
  if (!detected.installed || !detected.path) return false;
  const configDir = qoderConfigDir(config);
  const args = configDir ? ["--config-dir", configDir, "status"] : ["status"];
  const result = spawnSync(detected.path, args, {
    encoding: "utf8",
    env: { ...process.env, ...config.env },
    timeout: 5_000
  });
  if (result.error || result.status !== 0) return false;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return /^Username:\s*\S.+$/m.test(output) && /^Email:\s*\S.+$/m.test(output);
}

export function qoderConfigDir(config: ProviderRuntimeConfig, env: Record<string, string | undefined> = Bun.env): string {
  const explicit = clean(config.configDir) || clean(config.env.QODER_CONFIG_DIR) || clean(env.QODER_CONFIG_DIR);
  if (explicit) return explicit;
  const home = clean(env.HOME);
  return home ? join(home, ".qoder") : "";
}

function inspectQoderCli(command: string, env: Record<string, string>): { installed: boolean; version?: string; reason?: string } {
  const detected = detectProviderCommand(command);
  if (!detected.installed || !detected.path) return detected;
  if (/(?:^|\/)Qoder(?: IDE)?\.app\//.test(detected.path)) {
    return { installed: false, reason: "Qoder Desktop launcher is not a qodercli runtime" };
  }
  const result = spawnSync(detected.path, ["--version"], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 5_000
  });
  if (result.error || result.status !== 0) {
    return { installed: true, reason: "Qoder CLI version probe failed" };
  }
  const version = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
  if (!version) return { installed: true, reason: "Qoder CLI did not report a semantic version" };
  if (version !== QODER_VERSION_PAIR.cli) {
    return { installed: true, version, reason: `Qoder CLI version ${version} does not match ${QODER_VERSION_PAIR.cli}` };
  }
  return { installed: true, version };
}

function privateNonemptyFile(path: string): boolean {
  if (!path) return false;
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0 && (process.platform === "win32" || (stat.mode & 0o077) === 0);
  } catch {
    return false;
  }
}

function normalizeAuthMode(value: string | undefined): QoderAuthenticationStatus["mode"] {
  if (value === "pat-env" || value === "pat-secret-ref" || value === "service-account-secret-ref") return value;
  return "local-cli";
}

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}
