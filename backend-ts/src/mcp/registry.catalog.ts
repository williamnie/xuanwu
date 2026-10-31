import { readFileSync } from "node:fs";
import type { RunnerDatabase } from "../db/database.ts";
import { listPiMcpCapabilities } from "../db/repositories/piMcpCapabilities.ts";
import { listPiMcpServers } from "../db/repositories/piMcpServers.ts";
import { optionalJevMcpServers } from "../skills/jev/registry.ts";
import { cleanString, objectValue } from "../util/values.ts";
import { MAX_SERVERS, DEFAULT_REGISTRY } from "./registry.model.ts";
import type { McpRegistryOptions, McpServerRegistry, McpRegistry, McpRegistryDiagnostic, McpCapability, McpRecommendationInput, McpRequirementRecommendation, RawServer, RawCapability } from "./registry.model.ts";
import { normalizeServer } from "./registry.normalization.ts";
import { normalizeID, diagnostic } from "./registry.values.ts";
import { isUnavailableStatus, isNotReady, publicCapability, tokenize, issueText, recommendation, publicServer, parseJSON, isRegistryObject } from "./registry.presentation.ts";

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
  // 可选技能只在安装、启用且具备凭据时声明工具；错误配置不会阻断其他 MCP。
  return { diagnostics, servers: [...normalized.filter(server => server.id !== "jev-assist"),
    ...(options.database ? optionalJevMcpServers(options.database) : [])] };
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

export function managedRegistryServers(db: RunnerDatabase): RawServer[] {
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

export function managedServerStatus(status: string): string {
  return ["available", "configured", "discovered"].includes(status) ? "enabled" : status || "enabled";
}

export function managedCapability(capability: ReturnType<typeof listPiMcpCapabilities>[number]): RawCapability {
  return {
    description: capability.description, input_schema: capability.input_schema, name: capability.name, output_schema: capability.output_schema,
    metadata: capability.metadata,
    permission: capability.permission, read_only: capability.read_only, requires_confirmation: capability.requires_confirmation,
    risk_level: capability.risk_level, source_path: capability.source_path, timeout_ms: capability.timeout_ms, uri: capability.uri
  };
}

export function registryConfig(options: McpRegistryOptions, diagnostics: McpRegistryDiagnostic[]): Record<string, unknown> {
  const text = options.registryJson ?? Bun.env.XUANWU_MCP_REGISTRY_JSON ?? registryFileText(diagnostics) ?? DEFAULT_REGISTRY;
  const parsed = parseJSON(text);
  if (text.trim() !== "" && !isRegistryObject(parsed)) {
    diagnostics.push(diagnostic("registry_json_invalid", "registry", "MCP registry JSON is invalid"));
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

export function registryFileText(diagnostics: McpRegistryDiagnostic[]): string | undefined {
  const path = cleanString(Bun.env.XUANWU_MCP_REGISTRY_FILE);
  if (path === "") return undefined;
  try { return readFileSync(path, "utf8"); } catch {
    diagnostics.push(diagnostic("registry_file_unavailable", "registry-file", "MCP registry file is unavailable"));
    return DEFAULT_REGISTRY;
  }
}
