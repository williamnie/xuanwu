import { cleanString, objectValue } from "../util/values.ts";
import { MAX_CAPABILITIES_PER_SERVER } from "./registry.model.ts";
import type { RawServer, McpServerRegistry, McpCapability, McpCapabilityKind, RawCapability, McpPermission, McpRiskLevel, McpServerTransport } from "./registry.model.ts";
import { normalizeID, normalizeName } from "./registry.values.ts";
import { serverDiagnostics, jsonSchema, emptyObjectSchema } from "./registry.presentation.ts";

export function normalizeServer(server: RawServer): McpServerRegistry | null {
  const id = normalizeID(server.id ?? server.server_id ?? server.name);
  if (id === "") return null;
  const resources = rawCapabilities(server.resources).map((item) => normalizeCapability(id, "resource", item));
  const tools = rawCapabilities(server.tools).map((item) => normalizeCapability(id, "tool", item));
  const capabilities = [...resources, ...tools].filter(Boolean).slice(0, MAX_CAPABILITIES_PER_SERVER) as McpCapability[];
  const status = cleanString(server.status) || "unknown";
  const readiness = cleanString(server.readiness) || cleanString(server.ready) || "unknown";
  return {
    approval_mode: approvalMode(server.approval_mode),
    capabilities,
    description: cleanString(server.description ?? server.summary),
    diagnostics: serverDiagnostics(id, status, readiness),
    id,
    metadata: objectValue(server.metadata),
    name: cleanString(server.name) || id,
    permissions: permissionsFromServer(server, capabilities),
    readiness,
    resources: capabilities.filter((item) => item.kind === "resource"),
    risk_level: riskLevel(server.risk_level ?? server.risk, capabilities),
    status,
    tools: capabilities.filter((item) => item.kind === "tool"),
    ...optionalTransport(server.transport),
    version: cleanString(server.version) || undefined
  };
}

export function normalizeCapability(serverID: string, kind: McpCapabilityKind, raw: RawCapability): McpCapability | null {
  const name = normalizeName(raw.name ?? raw.id ?? raw.uri ?? raw.tool);
  if (name === "") return null;
  const metadata = objectValue(raw.metadata);
  const annotations = objectValue(raw.annotations ?? metadata.annotations);
  const readOnlyHint = annotations.readOnlyHint === true;
  const permission = permissionLevel(raw.permission ?? raw.permissions ?? (kind === "resource" || readOnlyHint ? "read" : "write"));
  const risk_level = capabilityRisk(raw.risk_level ?? raw.risk, permission, annotations);
  const readOnly = booleanValue(raw.read_only ?? raw.readOnly, permission === "read" && risk_level === "low");
  return {
    allowed_actions: allowedActions(kind, permission),
    description: cleanString(raw.description ?? raw.summary),
    id: `${serverID}:${kind}:${name}`,
    ...(kind === "tool" ? {
      input_schema: jsonSchema(raw.input_schema ?? raw.inputSchema ?? raw.parameters ?? raw.schema, emptyObjectSchema()),
      output_schema: jsonSchema(raw.output_schema ?? raw.outputSchema, { type: "object" })
    } : {}),
    kind,
    metadata: { ...metadata, ...(Object.keys(annotations).length > 0 ? { annotations } : {}) },
    name,
    permission,
    read_only: readOnly,
    requires_confirmation: booleanValue(
      raw.requires_confirmation ?? raw.requiresConfirmation,
      risk_level === "high" || permission === "admin" || (permission === "read" && risk_level === "medium")
    ),
    risk_level,
    server_id: serverID,
    ...optionalStringField("source_path", raw.source_path ?? raw.sourcePath),
    ...optionalTimeout(raw.timeout_ms ?? raw.timeoutMs),
    ...optionalURI(raw.uri)
  };
}

export function capabilityRisk(value: unknown, permission: McpPermission, annotations: Record<string, unknown>): McpRiskLevel {
  const explicit = cleanString(value).toLowerCase();
  if (["low", "medium", "high"].includes(explicit)) return explicit as McpRiskLevel;
  if (permission === "admin" || annotations.destructiveHint === true || annotations.openWorldHint === true) return "high";
  if (permission === "write") return "medium";
  return "low";
}

export function approvalMode(value: unknown): McpServerRegistry["approval_mode"] {
  const mode = cleanString(value);
  return mode === "every_write" || mode === "read_only" ? mode : "dangerous_only";
}

export function rawCapabilities(value: unknown): RawCapability[] {
  return Array.isArray(value) ? value.map(objectValue).filter((item) => Object.keys(item).length > 0) : [];
}

export function permissionsFromServer(server: RawServer, capabilities: McpCapability[]): McpPermission[] {
  const declared = Array.isArray(server.permissions) ? server.permissions.map(permissionLevel) : [];
  return [...new Set([...declared, ...capabilities.map((item) => item.permission)])];
}

export function allowedActions(kind: McpCapabilityKind, permission: McpPermission): string[] {
  if (kind === "resource" && permission === "read") return ["mcp.resource.read"];
  if (kind === "resource") return ["mcp.resource.read", "mcp.tool.call"];
  return ["mcp.tool.call"];
}

export function riskLevel(value: unknown, capabilities: McpCapability[]): McpRiskLevel {
  const text = cleanString(value).toLowerCase();
  if (["low", "medium", "high"].includes(text)) return text as McpRiskLevel;
  if (text === "admin" || text === "write") return "high";
  if (capabilities.some((item) => item.risk_level === "high")) return "high";
  if (capabilities.some((item) => item.risk_level === "medium")) return "medium";
  return "low";
}

export function permissionLevel(value: unknown): McpPermission {
  const text = Array.isArray(value) ? cleanString(value[0]).toLowerCase() : cleanString(value).toLowerCase();
  if (text === "admin" || text === "write") return text;
  return "read";
}

export function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

export function optionalTimeout(value: unknown): { timeout_ms?: number } {
  const parsed = typeof value === "number" ? value : Number.parseInt(cleanString(value), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? { timeout_ms: parsed } : {};
}

export function optionalURI(value: unknown): { uri?: string } {
  const uri = cleanString(value);
  return uri === "" ? {} : { uri };
}

export function optionalTransport(value: unknown): { transport?: McpServerTransport } {
  const raw = objectValue(value);
  const type = cleanString(raw.type).toLowerCase();
  const command = cleanString(raw.command ?? raw.executable);
  if (type !== "stdio" || command === "") return {};
  return {
    transport: {
      args: stringArray(raw.args),
      command,
      type: "stdio",
      ...optionalStringField("cwd", raw.cwd),
      ...optionalEnv(raw.env)
    }
  };
}

export function optionalStringField(key: "cwd", value: unknown): { cwd?: string };

export function optionalStringField(key: "source_path", value: unknown): { source_path?: string };

export function optionalStringField(key: "cwd" | "source_path", value: unknown): { cwd?: string; source_path?: string } {
  const text = cleanString(value);
  return text === "" ? {} : { [key]: text };
}

export function optionalEnv(value: unknown): { env?: Record<string, string> } {
  const raw = objectValue(value);
  const env = Object.fromEntries(Object.entries(raw)
    .map(([key, entry]) => [cleanString(key), cleanString(entry)])
    .filter(([key]) => key !== ""));
  return Object.keys(env).length === 0 ? {} : { env };
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(cleanString) : [];
}
