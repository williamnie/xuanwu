import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  parseCliConnectorManifestJson,
  type CliConnectorCommand,
  type CliConnectorManifest
} from "./cliConnectorManifest.ts";
import type {
  AssistantTool,
  ToolAuditMetadata,
  ToolEnvelopeMetadata,
  ToolPermission,
  ToolProvider
} from "./toolProviderEnvelope.ts";

export type CliConnectorRegistryOptions = {
  env?: Record<string, string | undefined>;
  manifestDirs?: string[];
};

export type CliConnectorDiagnostic = {
  code: "directory_unavailable" | "manifest_invalid" | "manifest_unreadable";
  message: string;
  path: string;
  provider_id?: string;
};

export type CliConnectorToolRef = {
  command: CliConnectorCommand;
  envNames: string[];
  manifest: CliConnectorManifest;
  manifestDir: string;
  manifestPath: string;
  provider: ToolProvider;
  secretEnvNames: string[];
  tool: AssistantTool;
};

export type CliConnectorRef = {
  envNames: string[];
  manifest: CliConnectorManifest;
  manifestDir: string;
  manifestPath: string;
  missingRequiredEnv: string[];
  provider: ToolProvider;
  secretEnvNames: string[];
};

export type CliConnectorRegistry = {
  connectors: CliConnectorRef[];
  diagnostics: CliConnectorDiagnostic[];
  providers: ToolProvider[];
  toolRefs: CliConnectorToolRef[];
  tools: AssistantTool[];
};

const SECRET_NAME_RE = /secret|token|password|passwd|credential|api[_-]?key|authorization/i;

export function loadCliConnectorRegistry(options: CliConnectorRegistryOptions = {}): CliConnectorRegistry {
  const diagnostics: CliConnectorDiagnostic[] = [];
  const loaded = configuredManifestFiles(options.manifestDirs ?? [], diagnostics)
    .flatMap((path) => loadManifest(path, options.env ?? process.env, diagnostics));
  return {
    connectors: loaded.map((entry) => entry.connector),
    diagnostics,
    providers: loaded.map((entry) => entry.connector.provider),
    toolRefs: loaded.flatMap((entry) => entry.toolRefs),
    tools: loaded.flatMap((entry) => entry.toolRefs.map((ref) => ref.tool))
  };
}

export function findCliConnectorToolRef(
  registry: CliConnectorRegistry,
  providerID: string,
  name: string
): CliConnectorToolRef | undefined {
  return registry.toolRefs.find((ref) => ref.tool.provider_id === providerID && ref.tool.name === name);
}

function configuredManifestFiles(dirs: string[], diagnostics: CliConnectorDiagnostic[]): string[] {
  return unique(dirs.map((dir) => dir.trim()).filter(Boolean).map((dir) => resolve(dir)))
    .flatMap((dir) => manifestFiles(dir, diagnostics));
}

function manifestFiles(dir: string, diagnostics: CliConnectorDiagnostic[]): string[] {
  try {
    if (!statSync(dir).isDirectory()) throw new Error("not a directory");
    return readdirSync(dir).filter((name) => name.endsWith(".json"))
      .map((name) => join(dir, name));
  } catch (error) {
    diagnostics.push(diagnostic("directory_unavailable", dir, safeMessage(error)));
    return [];
  }
}

function loadManifest(
  path: string,
  env: Record<string, string | undefined>,
  diagnostics: CliConnectorDiagnostic[]
): Array<{ connector: CliConnectorRef; toolRefs: CliConnectorToolRef[] }> {
  const parsed = readManifest(path, diagnostics);
  if (!parsed) return [];
  if (!parsed.ok) {
    diagnostics.push(diagnostic("manifest_invalid", path, issuesMessage(parsed.issues), providerIDHint(path)));
    return [];
  }
  const manifest = parsed.manifest;
  const envNames = declaredEnvNames(manifest);
  const secretEnvNames = secretNames(manifest, envNames);
  const missing = missingRequiredEnv(manifest, env);
  const provider = providerFromManifest(manifest, path, secretEnvNames, missing);
  const connector = connectorFromManifest(manifest, path, provider, envNames, secretEnvNames, missing);
  const toolRefs = missing.length === 0 ? toolRefsFromManifest(manifest, path, provider, envNames, secretEnvNames) : [];
  return [{ connector, toolRefs }];
}

function readManifest(path: string, diagnostics: CliConnectorDiagnostic[]) {
  try {
    return parseCliConnectorManifestJson(readFileSync(path, "utf8"));
  } catch (error) {
    diagnostics.push(diagnostic("manifest_unreadable", path, safeMessage(error), providerIDHint(path)));
    return undefined;
  }
}

function providerFromManifest(
  manifest: CliConnectorManifest,
  path: string,
  secretEnvNames: string[],
  missingRequiredEnv: string[]
): ToolProvider {
  return {
    audit: auditMetadata(secretEnvNames.map((name) => `env.${name}`)),
    default_timeout_ms: manifest.timeout?.default_ms,
    description: manifest.description ?? "",
    id: manifest.id,
    kind: "cli",
    metadata: providerMetadata(manifest, path, missingRequiredEnv),
    name: manifest.name,
    status: missingRequiredEnv.length > 0 ? "disabled" : "enabled"
  };
}

function connectorFromManifest(
  manifest: CliConnectorManifest,
  path: string,
  provider: ToolProvider,
  envNames: string[],
  secretEnvNames: string[],
  missingRequiredEnv: string[]
): CliConnectorRef {
  return {
    envNames,
    manifest,
    manifestDir: resolve(join(path, "..")),
    manifestPath: path,
    missingRequiredEnv,
    provider,
    secretEnvNames
  };
}

function toolRefsFromManifest(
  manifest: CliConnectorManifest,
  path: string,
  provider: ToolProvider,
  envNames: string[],
  secretEnvNames: string[]
): CliConnectorToolRef[] {
  return manifest.commands.map((command) => ({
    command,
    envNames,
    manifest,
    manifestDir: resolve(join(path, "..")),
    manifestPath: path,
    provider,
    secretEnvNames,
    tool: toolFromCommand(manifest, provider, command, secretEnvNames)
  }));
}

function toolFromCommand(
  manifest: CliConnectorManifest,
  provider: ToolProvider,
  command: CliConnectorCommand,
  secretEnvNames: string[]
): AssistantTool {
  return {
    audit: auditMetadata([...secretEnvNames.map((name) => `env.${name}`), ...secretInputPaths(command)]),
    description: command.description,
    input_schema: command.input_schema,
    metadata: commandMetadata(command),
    name: command.name,
    output_schema: command.output_schema,
    permission: command.permission,
    provider_id: provider.id,
    timeout_ms: command.timeout_ms ?? manifest.timeout?.default_ms
  };
}

function providerMetadata(
  manifest: CliConnectorManifest,
  path: string,
  missingRequiredEnv: string[]
): ToolEnvelopeMetadata {
  return {
    auth_type: manifest.auth?.type ?? "none",
    command_count: manifest.commands.length,
    connector: "cli",
    env: manifest.env ?? [],
    manifest_file: basename(path),
    manifest_version: manifest.manifest_version,
    missing_required_env: missingRequiredEnv
  };
}

function commandMetadata(command: CliConnectorCommand): ToolEnvelopeMetadata {
  return {
    command: command.command,
    connector: "cli",
    cursor: command.cursor ?? {},
    exit_codes: command.exit_codes,
    idempotency: command.idempotency ?? {},
    stderr: command.stderr ?? {},
    stdout: command.stdout
  };
}

function declaredEnvNames(manifest: CliConnectorManifest): string[] {
  return unique([...(manifest.auth?.env ?? []), ...(manifest.env ?? []).map((item) => item.name)]);
}

function secretNames(manifest: CliConnectorManifest, envNames: string[]): string[] {
  const declaredSecret = new Set((manifest.env ?? []).filter((item) => item.secret).map((item) => item.name));
  return envNames.filter((name) => declaredSecret.has(name) || SECRET_NAME_RE.test(name));
}

function missingRequiredEnv(manifest: CliConnectorManifest, env: Record<string, string | undefined>): string[] {
  return (manifest.env ?? []).filter((item) => item.required && cleanString(env[item.name]) === "")
    .map((item) => item.name);
}

function secretInputPaths(command: CliConnectorCommand): string[] {
  return schemaPropertyNames(command.input_schema).filter((name) => SECRET_NAME_RE.test(name))
    .map((name) => `input.${name}`);
}

function schemaPropertyNames(schema: Record<string, unknown>): string[] {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
  return Object.keys(properties);
}

function auditMetadata(redact: string[]): ToolAuditMetadata {
  return { redact: unique(redact), category: "cli_connector", tags: ["cli"] };
}

function diagnostic(
  code: CliConnectorDiagnostic["code"],
  path: string,
  message: string,
  providerID?: string
): CliConnectorDiagnostic {
  return { code, message, path, ...(providerID ? { provider_id: providerID } : {}) };
}

function issuesMessage(issues: Array<{ path: string; message: string }>): string {
  return issues.slice(0, 3).map((issue) => `${issue.path}: ${issue.message}`).join("; ");
}

function providerIDHint(path: string): string | undefined {
  return basename(path).replace(/\.json$/i, "") || undefined;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
