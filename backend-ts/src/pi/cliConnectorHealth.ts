import { basename } from "node:path";
import { loadCliConnectorRegistry, type CliConnectorDiagnostic, type CliConnectorRef } from "./cliConnectorProvider.ts";
import { runCliTool } from "./cliToolRunner.ts";
import type { ToolResult, ToolResultError } from "./toolProviderEnvelope.ts";

export type CliConnectorHealthState = "configured" | "disabled" | "misconfigured" | "error";

export type CliConnectorHealthOptions = {
  env?: Record<string, string | undefined>;
  manifestDirs?: string[];
};

export type CliConnectorHealthReport = {
  connectors: Array<Record<string, unknown>>;
  diagnostics: CliConnectorDiagnostic[];
};

type HealthSummary = {
  error: string;
  state: CliConnectorHealthState;
};

export async function checkCliConnectorHealth(
  options: CliConnectorHealthOptions = {}
): Promise<CliConnectorHealthReport> {
  const registry = loadCliConnectorRegistry({
    env: options.env ?? process.env,
    manifestDirs: options.manifestDirs ?? []
  });
  const connectors = await Promise.all(registry.connectors.map((ref) => connectorHealth(ref, options.env)));
  return {
    connectors: [...connectors, ...diagnosticConnectors(registry.diagnostics)],
    diagnostics: registry.diagnostics.map(publicDiagnostic)
  };
}

async function connectorHealth(
  ref: CliConnectorRef,
  env: Record<string, string | undefined> | undefined
): Promise<Record<string, unknown>> {
  if (ref.missingRequiredEnv.length > 0) return staticConnectorHealth(ref, env);
  const result = await runCliTool({
    command: ref.manifest.health,
    cwd: ref.manifestDir,
    env,
    envAllowlist: ref.envNames,
    invocationID: `cli-health:${ref.provider.id}:${crypto.randomUUID()}`,
    secretEnvNames: ref.secretEnvNames,
    timeoutMs: ref.manifest.health.timeout_ms ?? ref.manifest.timeout?.default_ms
  });
  return healthEntry(ref, env, healthState(result), resultHealth(result));
}

function staticConnectorHealth(
  ref: CliConnectorRef,
  env: Record<string, string | undefined> | undefined
): Record<string, unknown> {
  const status = missingEnvState(ref, env);
  return healthEntry(ref, env, status, {
    checked: false,
    ok: false,
    status: "skipped"
  });
}

function healthEntry(
  ref: CliConnectorRef,
  env: Record<string, string | undefined> | undefined,
  status: CliConnectorHealthState,
  health: Record<string, unknown>
): Record<string, unknown> {
  const summary = summaryFor(status, health);
  return {
    id: ref.provider.id,
    label: ref.provider.name,
    kind: "cli",
    enabled: status === "configured",
    status,
    description: ref.provider.description ?? "",
    settings_mode: "cli_connector_manifest",
    manifest_file: basename(ref.manifestPath),
    command_count: ref.manifest.commands.length,
    env: envStatus(ref, env),
    missing_required: ref.missingRequiredEnv,
    health,
    summary: { configured: status === "configured", ...summary }
  };
}

function resultHealth(result: ToolResult): Record<string, unknown> {
  return {
    checked: true,
    checked_at: result.ended_at ?? new Date().toISOString(),
    duration_ms: result.duration_ms ?? 0,
    ok: result.status === "succeeded",
    status: result.status,
    ...(result.error ? { error: publicError(result.error) } : {})
  };
}

function healthState(result: ToolResult): CliConnectorHealthState {
  if (result.status === "succeeded") return "configured";
  const category = exitCategory(result.error);
  if (category === "auth_required" || category === "usage_error") return "misconfigured";
  return "error";
}

function publicError(error: ToolResultError): Record<string, unknown> {
  return {
    ...(error.code ? { code: error.code } : {}),
    message: error.message,
    ...(exitCategory(error) ? { exit_category: exitCategory(error) } : {})
  };
}

function exitCategory(error: ToolResultError | undefined): string {
  const details = error?.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return "";
  const value = (details as Record<string, unknown>).exit_category;
  return typeof value === "string" ? value : "";
}

function missingEnvState(ref: CliConnectorRef, env: Record<string, string | undefined> | undefined): CliConnectorHealthState {
  return ref.envNames.some((name) => cleanString((env ?? process.env)[name]) !== "") ? "misconfigured" : "disabled";
}

function envStatus(
  ref: CliConnectorRef,
  env: Record<string, string | undefined> | undefined
): Array<Record<string, unknown>> {
  const declared = ref.manifest.env ?? [];
  return declared.map((item) => ({
    name: item.name,
    required: item.required === true,
    secret: item.secret === true,
    configured: cleanString((env ?? process.env)[item.name]) !== ""
  }));
}

function summaryFor(status: CliConnectorHealthState, health: Record<string, unknown>): HealthSummary {
  const error = healthErrorText(health);
  return { error, state: status };
}

function healthErrorText(health: Record<string, unknown>): string {
  const error = health.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return "";
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" ? message : "";
}

function diagnosticConnectors(diagnostics: CliConnectorDiagnostic[]): Array<Record<string, unknown>> {
  return diagnostics.filter((item) => item.code !== "directory_unavailable").map((item) => ({
    id: item.provider_id ?? basename(item.path).replace(/\.json$/i, ""),
    label: item.provider_id ?? basename(item.path),
    kind: "cli",
    enabled: false,
    status: "misconfigured",
    settings_mode: "cli_connector_manifest",
    manifest_file: basename(item.path),
    missing_required: [],
    health: { checked: false, ok: false, status: "skipped", error: { code: item.code, message: item.message } },
    summary: { configured: false, error: item.message, state: "misconfigured" }
  }));
}

function publicDiagnostic(item: CliConnectorDiagnostic): CliConnectorDiagnostic {
  return { ...item, path: basename(item.path) };
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
