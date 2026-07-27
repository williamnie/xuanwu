import { readFileSync } from "node:fs";
import type { RunnerDatabase } from "../db/database.ts";
import { listPiMcpCapabilities } from "../db/repositories/piMcpCapabilities.ts";
import { listPiMcpServers } from "../db/repositories/piMcpServers.ts";
import { mcpCapabilitiesFromPayload, parseMcpCapabilityList } from "./policy.ts";

export type McpRiskLevel = "low" | "medium" | "high";
export type McpCapabilityKind = "resource" | "tool";
export type McpPermission = "read" | "write" | "admin";

export type McpCapability = {
  allowed_actions: string[];
  description: string;
  id: string;
  input_schema?: Record<string, unknown>;
  kind: McpCapabilityKind;
  metadata: Record<string, unknown>;
  name: string;
  output_schema?: Record<string, unknown>;
  permission: McpPermission;
  read_only: boolean;
  requires_confirmation: boolean;
  risk_level: McpRiskLevel;
  server_id: string;
  source_path?: string;
  timeout_ms?: number;
  uri?: string;
};

export type McpServerTransport = {
  args: string[];
  command: string;
  type: "stdio";
  cwd?: string;
  env?: Record<string, string>;
};

export type McpServerRegistry = {
  approval_mode: "dangerous_only" | "every_write" | "read_only";
  capabilities: McpCapability[];
  description: string;
  diagnostics: McpRegistryDiagnostic[];
  id: string;
  metadata: Record<string, unknown>;
  name: string;
  permissions: McpPermission[];
  readiness: string;
  resources: McpCapability[];
  risk_level: McpRiskLevel;
  status: string;
  tools: McpCapability[];
  transport?: McpServerTransport;
  version?: string;
};

export type McpRegistryDiagnostic = {
  code: "registry_file_unavailable" | "registry_json_invalid" | "server_not_ready" | "server_unavailable" | string;
  message: string;
  readiness?: string;
  server_id: string;
  severity: "warning";
  source_path: string;
  status?: string;
};

export type McpRegistry = { diagnostics: McpRegistryDiagnostic[]; servers: McpServerRegistry[] };
export type McpRecommendationInput = { description?: string; issue?: unknown; title?: string };
export type McpRequirementRecommendation = McpCapability & { reason: string; score: number };
export type McpRegistryOptions = { database?: RunnerDatabase; registryJson?: string };

type RawServer = Record<string, unknown>;
type RawCapability = Record<string, unknown>;

const MAX_SERVERS = 80;
const MAX_CAPABILITIES_PER_SERVER = 160;
const DEFAULT_REGISTRY = "{}";

export function listMcpRegistry(options: McpRegistryOptions = {}): McpServerRegistry[] {
  return readMcpRegistry(options).servers;
}

export function readMcpRegistry(options: McpRegistryOptions = {}): McpRegistry {
  const diagnostics: McpRegistryDiagnostic[] = [];
  const config = registryConfig(options, diagnostics);
  const servers = Array.isArray(config.servers) ? config.servers : [];
  const managed = options.database ? managedRegistryServers(options.database) : [];
  const normalized = [...servers, ...managed].map((server) => normalizeServer(objectValue(server))).filter(Boolean)
    .slice(0, MAX_SERVERS) as McpServerRegistry[];
  diagnostics.push(...normalized.flatMap((server) => server.diagnostics));
  return { diagnostics, servers: normalized };
}

export function readMcpCapability(id: string, options: McpRegistryOptions = {}): McpCapability | null {
  const wanted = normalizeID(id);
  return listMcpRegistry(options).flatMap((server) => server.capabilities).find((capability) => capability.id === wanted) ?? null;
}

export function readMcpServer(id: string, options: McpRegistryOptions = {}): McpServerRegistry | null {
  const wanted = normalizeID(id);
  return listMcpRegistry(options).find((server) => server.id === wanted) ?? null;
}

export function isMcpServerAuthorized(server: Pick<McpServerRegistry, "readiness" | "status">): boolean {
  return !isUnavailableStatus(server.status) && !isNotReady(server.readiness);
}

export function listMcpResources(serverID = "", options: McpRegistryOptions = {}): McpCapability[] {
  const wantedServer = normalizeID(serverID);
  return listMcpRegistry(options)
    .filter((server) => wantedServer === "" || server.id === wantedServer)
    .filter(isMcpServerAuthorized)
    .flatMap((server) => server.resources)
    .filter((resource) => resource.read_only)
    .map(publicCapability);
}

export function recommendMcpRequirements(
  input: McpRecommendationInput,
  options: McpRegistryOptions = {}
): McpRequirementRecommendation[] {
  const terms = tokenize(`${input.title ?? ""} ${input.description ?? ""} ${issueText(input.issue)}`);
  if (terms.length === 0) return [];
  return listMcpRegistry(options).flatMap((server) => server.capabilities)
    .map((capability) => recommendation(capability, terms))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, 8);
}

export function publicMcpRegistry(options: McpRegistryOptions = {}): McpServerRegistry[] {
  return listMcpRegistry(options).map(publicServer);
}

export function mcpCapabilityIDsFromPayload(payload: Record<string, unknown>): string[] {
  return mcpCapabilitiesFromPayload(payload);
}

export function normalizeMcpCapabilityIDs(value: unknown): string[] {
  return parseMcpCapabilityList(value);
}


function managedRegistryServers(db: RunnerDatabase): RawServer[] {
  const capabilities = listPiMcpCapabilities(db).filter((capability) => capability.enabled);
  const byServer = new Map<string, typeof capabilities>();
  for (const capability of capabilities) byServer.set(capability.server_id, [...(byServer.get(capability.server_id) ?? []), capability]);
  return listPiMcpServers(db).filter((server) => server.enabled).map((server) => {
    const items = byServer.get(server.id) ?? [];
    return {
      approval_mode: server.approval_mode, description: server.description, id: server.id, metadata: server.metadata, name: server.name,
      readiness: server.readiness || "unknown", risk_level: server.risk_level,
      resources: items.filter((item) => item.kind === "resource").map(managedCapability),
      status: managedServerStatus(server.status),
      tools: items.filter((item) => item.kind === "tool").map(managedCapability),
      transport: server.transport_type === "stdio" ? { args: server.args, command: server.command, cwd: server.cwd, env: server.env, type: "stdio" } : undefined
    };
  });
}

function managedServerStatus(status: string): string {
  return ["available", "configured", "discovered"].includes(status) ? "enabled" : status || "enabled";
}

function managedCapability(capability: ReturnType<typeof listPiMcpCapabilities>[number]): RawCapability {
  return {
    description: capability.description, input_schema: capability.input_schema, name: capability.name, output_schema: capability.output_schema,
    metadata: capability.metadata,
    permission: capability.permission, read_only: capability.read_only, requires_confirmation: capability.requires_confirmation,
    risk_level: capability.risk_level, source_path: capability.source_path, timeout_ms: capability.timeout_ms, uri: capability.uri
  };
}

function registryConfig(options: McpRegistryOptions, diagnostics: McpRegistryDiagnostic[]): Record<string, unknown> {
  const text = options.registryJson ?? Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON ?? registryFileText(diagnostics) ?? DEFAULT_REGISTRY;
  const parsed = parseJSON(text);
  if (text.trim() !== "" && !isRegistryObject(parsed)) {
    diagnostics.push(diagnostic("registry_json_invalid", "registry", "MCP registry JSON is invalid"));
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function registryFileText(diagnostics: McpRegistryDiagnostic[]): string | undefined {
  const path = cleanString(Bun.env.CODEX_RUNNER_MCP_REGISTRY_FILE);
  if (path === "") return undefined;
  try { return readFileSync(path, "utf8"); } catch {
    diagnostics.push(diagnostic("registry_file_unavailable", "registry-file", "MCP registry file is unavailable"));
    return DEFAULT_REGISTRY;
  }
}

function normalizeServer(server: RawServer): McpServerRegistry | null {
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

function normalizeCapability(serverID: string, kind: McpCapabilityKind, raw: RawCapability): McpCapability | null {
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

function capabilityRisk(value: unknown, permission: McpPermission, annotations: Record<string, unknown>): McpRiskLevel {
  const explicit = cleanString(value).toLowerCase();
  if (["low", "medium", "high"].includes(explicit)) return explicit as McpRiskLevel;
  if (permission === "admin" || annotations.destructiveHint === true || annotations.openWorldHint === true) return "high";
  if (permission === "write") return "medium";
  return "low";
}

function approvalMode(value: unknown): McpServerRegistry["approval_mode"] {
  const mode = cleanString(value);
  return mode === "every_write" || mode === "read_only" ? mode : "dangerous_only";
}

function rawCapabilities(value: unknown): RawCapability[] {
  return Array.isArray(value) ? value.map(objectValue).filter((item) => Object.keys(item).length > 0) : [];
}

function permissionsFromServer(server: RawServer, capabilities: McpCapability[]): McpPermission[] {
  const declared = Array.isArray(server.permissions) ? server.permissions.map(permissionLevel) : [];
  return [...new Set([...declared, ...capabilities.map((item) => item.permission)])];
}

function allowedActions(kind: McpCapabilityKind, permission: McpPermission): string[] {
  if (kind === "resource" && permission === "read") return ["mcp.resource.read"];
  if (kind === "resource") return ["mcp.resource.read", "mcp.tool.call"];
  return ["mcp.tool.call"];
}

function riskLevel(value: unknown, capabilities: McpCapability[]): McpRiskLevel {
  const text = cleanString(value).toLowerCase();
  if (["low", "medium", "high"].includes(text)) return text as McpRiskLevel;
  if (text === "admin" || text === "write") return "high";
  if (capabilities.some((item) => item.risk_level === "high")) return "high";
  if (capabilities.some((item) => item.risk_level === "medium")) return "medium";
  return "low";
}

function permissionLevel(value: unknown): McpPermission {
  const text = Array.isArray(value) ? cleanString(value[0]).toLowerCase() : cleanString(value).toLowerCase();
  if (text === "admin" || text === "write") return text;
  return "read";
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

function optionalTimeout(value: unknown): { timeout_ms?: number } {
  const parsed = typeof value === "number" ? value : Number.parseInt(cleanString(value), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? { timeout_ms: parsed } : {};
}

function optionalURI(value: unknown): { uri?: string } {
  const uri = cleanString(value);
  return uri === "" ? {} : { uri };
}

function optionalTransport(value: unknown): { transport?: McpServerTransport } {
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

function optionalStringField(key: "cwd", value: unknown): { cwd?: string };
function optionalStringField(key: "source_path", value: unknown): { source_path?: string };
function optionalStringField(key: "cwd" | "source_path", value: unknown): { cwd?: string; source_path?: string } {
  const text = cleanString(value);
  return text === "" ? {} : { [key]: text };
}

function optionalEnv(value: unknown): { env?: Record<string, string> } {
  const raw = objectValue(value);
  const env = Object.fromEntries(Object.entries(raw)
    .map(([key, entry]) => [cleanString(key), cleanString(entry)])
    .filter(([key]) => key !== ""));
  return Object.keys(env).length === 0 ? {} : { env };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(cleanString) : [];
}

function recommendation(capability: McpCapability, terms: string[]): McpRequirementRecommendation {
  const haystack = tokenize(`${capability.id} ${capability.name} ${capability.description} ${capability.server_id}`);
  const matches = terms.filter((term) => haystack.some((word) => word.includes(term) || term.includes(word)));
  return { ...publicCapability(capability), reason: `matched ${matches.slice(0, 4).join(", ")}`, score: new Set(matches).size };
}

function publicServer(server: McpServerRegistry): McpServerRegistry {
  const { transport: _transport, ...safe } = server;
  return {
    ...safe,
    capabilities: server.capabilities.map(publicCapability),
    resources: server.resources.map(publicCapability),
    tools: server.tools.map(publicCapability)
  };
}

function publicCapability(capability: McpCapability): McpCapability {
  return capability;
}

function serverDiagnostics(id: string, status: string, readiness: string): McpRegistryDiagnostic[] {
  const diagnostics: McpRegistryDiagnostic[] = [];
  if (isUnavailableStatus(status)) {
    diagnostics.push(diagnostic("server_unavailable", id, `MCP server ${id} is unavailable`, status, readiness));
  }
  if (isNotReady(readiness)) {
    diagnostics.push(diagnostic("server_not_ready", id, `MCP server ${id} readiness is ${readiness}`, status, readiness));
  }
  return diagnostics;
}

function isUnavailableStatus(status: string): boolean {
  return ["disabled", "error", "failed", "missing", "offline", "unavailable"].includes(status.toLowerCase());
}

function isNotReady(readiness: string): boolean {
  const value = readiness.toLowerCase();
  return value !== "" && !["available", "ready", "unknown"].includes(value);
}

function issueText(issue: unknown): string {
  const object = objectValue(issue);
  return `${cleanString(object.title)} ${cleanString(object.description)}`;
}

function tokenize(text: string): string[] {
  return cleanString(text).toLowerCase().split(/[^a-z0-9_:-]+/).filter((term) => term.length >= 3);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function jsonSchema(value: unknown, fallback: Record<string, unknown>): Record<string, unknown> {
  const schema = objectValue(value);
  return Object.keys(schema).length > 0 ? schema : fallback;
}

function emptyObjectSchema(): Record<string, unknown> {
  return { additionalProperties: false, properties: {}, type: "object" };
}

function parseJSON(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

function isRegistryObject(value: unknown): boolean {
  return value !== undefined && typeof value === "object" && !Array.isArray(value);
}

function diagnostic(
  code: McpRegistryDiagnostic["code"],
  source: string,
  message: string,
  status = "",
  readiness = ""
): McpRegistryDiagnostic {
  return {
    code,
    message,
    ...(readiness === "" ? {} : { readiness }),
    server_id: code.startsWith("server_") ? source : "",
    severity: "warning",
    source_path: `mcp-registry:${source}`,
    ...(status === "" ? {} : { status })
  };
}

function normalizeID(value: unknown): string {
  return cleanString(value).toLowerCase().replace(/[^a-z0-9_:-]+/g, "-").replace(/^-+|-+$/g, "");
}

function normalizeName(value: unknown): string {
  return cleanString(value).toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "");
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
