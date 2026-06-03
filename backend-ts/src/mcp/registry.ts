import { readFileSync } from "node:fs";
import { mcpCapabilitiesFromPayload, parseMcpCapabilityList } from "./policy.ts";

export type McpRiskLevel = "low" | "medium" | "high";
export type McpCapabilityKind = "resource" | "tool";
export type McpPermission = "read" | "write" | "admin";

export type McpCapability = {
  allowed_actions: string[];
  content?: unknown;
  description: string;
  id: string;
  kind: McpCapabilityKind;
  name: string;
  permission: McpPermission;
  read_only: boolean;
  requires_confirmation: boolean;
  risk_level: McpRiskLevel;
  server_id: string;
};

export type McpServerRegistry = {
  capabilities: McpCapability[];
  id: string;
  permissions: McpPermission[];
  readiness: string;
  resources: McpCapability[];
  risk_level: McpRiskLevel;
  status: string;
  tools: McpCapability[];
};

export type McpRecommendationInput = { description?: string; issue?: unknown; title?: string };
export type McpRequirementRecommendation = McpCapability & { reason: string; score: number };
export type McpRegistryOptions = { registryJson?: string };

type RawServer = Record<string, unknown>;
type RawCapability = Record<string, unknown>;

const MAX_SERVERS = 80;
const MAX_CAPABILITIES_PER_SERVER = 160;
const DEFAULT_REGISTRY = "{}";

export function listMcpRegistry(options: McpRegistryOptions = {}): McpServerRegistry[] {
  const config = registryConfig(options);
  const servers = Array.isArray(config.servers) ? config.servers : [];
  return servers.map((server) => normalizeServer(objectValue(server))).filter(Boolean).slice(0, MAX_SERVERS) as McpServerRegistry[];
}

export function readMcpCapability(id: string, options: McpRegistryOptions = {}): McpCapability | null {
  const wanted = normalizeID(id);
  return listMcpRegistry(options).flatMap((server) => server.capabilities).find((capability) => capability.id === wanted) ?? null;
}

export function listMcpResources(serverID = "", options: McpRegistryOptions = {}): McpCapability[] {
  const wantedServer = normalizeID(serverID);
  return listMcpRegistry(options)
    .filter((server) => wantedServer === "" || server.id === wantedServer)
    .flatMap((server) => server.resources)
    .filter((resource) => resource.read_only)
    .map(publicCapability);
}

export function readMcpResource(capabilityID: string, options: McpRegistryOptions = {}) {
  const capability = readMcpCapability(capabilityID, options);
  if (!capability || capability.kind !== "resource") return { capability_id: normalizeID(capabilityID), missing: true };
  return { capability: publicCapability(capability), content: capability.content ?? null };
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
  return listMcpRegistry(options).map((server) => ({
    ...server,
    capabilities: server.capabilities.map(publicCapability),
    resources: server.resources.map(publicCapability),
    tools: server.tools.map(publicCapability)
  }));
}

export function mcpCapabilityIDsFromPayload(payload: Record<string, unknown>): string[] {
  return mcpCapabilitiesFromPayload(payload);
}

export function normalizeMcpCapabilityIDs(value: unknown): string[] {
  return parseMcpCapabilityList(value);
}

function registryConfig(options: McpRegistryOptions): Record<string, unknown> {
  const text = options.registryJson ?? Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON ?? registryFileText() ?? DEFAULT_REGISTRY;
  const parsed = parseJSON(text);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function registryFileText(): string | undefined {
  const path = cleanString(Bun.env.CODEX_RUNNER_MCP_REGISTRY_FILE);
  if (path === "") return undefined;
  try { return readFileSync(path, "utf8"); } catch { return DEFAULT_REGISTRY; }
}

function normalizeServer(server: RawServer): McpServerRegistry | null {
  const id = normalizeID(server.id ?? server.server_id ?? server.name);
  if (id === "") return null;
  const resources = rawCapabilities(server.resources).map((item) => normalizeCapability(id, "resource", item));
  const tools = rawCapabilities(server.tools).map((item) => normalizeCapability(id, "tool", item));
  const capabilities = [...resources, ...tools].filter(Boolean).slice(0, MAX_CAPABILITIES_PER_SERVER) as McpCapability[];
  return {
    capabilities,
    id,
    permissions: permissionsFromServer(server, capabilities),
    readiness: cleanString(server.readiness) || cleanString(server.ready) || "unknown",
    resources: capabilities.filter((item) => item.kind === "resource"),
    risk_level: riskLevel(server.risk_level ?? server.risk, capabilities),
    status: cleanString(server.status) || "unknown",
    tools: capabilities.filter((item) => item.kind === "tool")
  };
}

function normalizeCapability(serverID: string, kind: McpCapabilityKind, raw: RawCapability): McpCapability | null {
  const name = normalizeName(raw.name ?? raw.id ?? raw.uri ?? raw.tool);
  if (name === "") return null;
  const permission = permissionLevel(raw.permission ?? raw.permissions ?? (kind === "resource" ? "read" : "write"));
  const risk_level = riskLevel(raw.risk_level ?? raw.risk ?? permission, []);
  return {
    allowed_actions: allowedActions(kind, permission),
    content: raw.content ?? raw.value,
    description: cleanString(raw.description ?? raw.summary),
    id: `${serverID}:${kind}:${name}`,
    kind,
    name,
    permission,
    read_only: permission === "read" && risk_level === "low",
    requires_confirmation: risk_level !== "low" || permission !== "read",
    risk_level,
    server_id: serverID
  };
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

function recommendation(capability: McpCapability, terms: string[]): McpRequirementRecommendation {
  const haystack = tokenize(`${capability.id} ${capability.name} ${capability.description} ${capability.server_id}`);
  const matches = terms.filter((term) => haystack.some((word) => word.includes(term) || term.includes(word)));
  return { ...publicCapability(capability), reason: `matched ${matches.slice(0, 4).join(", ")}`, score: new Set(matches).size };
}

function publicCapability(capability: McpCapability): McpCapability {
  const { content: _content, ...safe } = capability;
  return safe;
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

function parseJSON(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
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
