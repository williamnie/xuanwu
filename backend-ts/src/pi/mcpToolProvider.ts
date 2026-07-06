import {
  isMcpServerAuthorized,
  readMcpRegistry,
  type McpCapability,
  type McpRegistryDiagnostic,
  type McpRegistryOptions,
  type McpServerRegistry
} from "../mcp/registry.ts";
import type {
  AssistantTool,
  ToolAuditMetadata,
  ToolEnvelopeMetadata,
  ToolJsonSchema,
  ToolPermission,
  ToolProvider
} from "./toolProviderEnvelope.ts";

export type McpToolProviderRegistry = {
  diagnostics: McpRegistryDiagnostic[];
  providers: ToolProvider[];
  tools: AssistantTool[];
};

const SECRET_NAME_RE = /secret|token|password|passwd|credential|api[_-]?key|authorization/i;
const UNAVAILABLE_STATUSES = new Set(["disabled", "error", "failed", "missing", "offline", "unavailable"]);

export function loadMcpToolProviderRegistry(options: McpRegistryOptions = {}): McpToolProviderRegistry {
  const registry = readMcpRegistry(options);
  return {
    diagnostics: registry.diagnostics,
    providers: registry.servers.map(providerFromServer),
    tools: registry.servers.flatMap((server) => server.tools.map((tool) => toolFromCapability(server, tool)))
  };
}

export function mcpToolProviderID(serverID: string): string {
  return `mcp-${serverID.replace(/:/g, "-")}`;
}

function providerFromServer(server: McpServerRegistry): ToolProvider {
  return {
    audit: auditMetadata([]),
    description: server.description || `MCP server ${server.id}.`,
    id: mcpToolProviderID(server.id),
    kind: "mcp",
    metadata: providerMetadata(server),
    name: server.name || server.id,
    status: providerStatus(server),
    version: server.version
  };
}

function toolFromCapability(server: McpServerRegistry, capability: McpCapability): AssistantTool {
  return {
    audit: auditMetadata(secretSchemaPaths(capability.input_schema)),
    description: capability.description || `MCP tool ${capability.name} from ${server.name || server.id}.`,
    input_schema: schemaOrObject(capability.input_schema),
    metadata: toolMetadata(server, capability),
    name: capability.name,
    output_schema: schemaOrObject(capability.output_schema),
    permission: assistantPermission(capability),
    provider_id: mcpToolProviderID(server.id),
    timeout_ms: capability.timeout_ms
  };
}

function providerMetadata(server: McpServerRegistry): ToolEnvelopeMetadata {
  return {
    capability_count: server.capabilities.length,
    connector: "mcp",
    diagnostics: server.diagnostics,
    readiness: server.readiness,
    resource_count: server.resources.length,
    risk_level: server.risk_level,
    server_id: server.id,
    server_metadata: server.metadata,
    status: server.status,
    tool_count: server.tools.length
  };
}

function toolMetadata(server: McpServerRegistry, capability: McpCapability): ToolEnvelopeMetadata {
  return {
    allowed_actions: capability.allowed_actions,
    capability_id: capability.id,
    connector: "mcp",
    mcp_permission: capability.permission,
    provider_status: providerStatus(server),
    read_only: capability.read_only,
    readiness: server.readiness,
    requires_confirmation: capability.requires_confirmation,
    risk_level: capability.risk_level,
    server_id: server.id,
    status: server.status
  };
}

function providerStatus(server: Pick<McpServerRegistry, "readiness" | "status">): ToolProvider["status"] {
  if (UNAVAILABLE_STATUSES.has(server.status.toLowerCase())) return "disabled";
  return isMcpServerAuthorized(server) ? "enabled" : "degraded";
}

function assistantPermission(capability: McpCapability): ToolPermission {
  if (capability.permission === "admin" || capability.risk_level === "high") return "dangerous";
  if (capability.permission === "write" || capability.risk_level === "medium") return "write";
  return "read";
}

function schemaOrObject(schema: ToolJsonSchema | undefined): ToolJsonSchema {
  return schema && Object.keys(schema).length > 0 ? schema : { type: "object" };
}

function secretSchemaPaths(schema: ToolJsonSchema | undefined): string[] {
  const properties = schema?.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
  return Object.keys(properties).filter((name) => SECRET_NAME_RE.test(name)).map((name) => `input.${name}`);
}

function auditMetadata(redact: string[]): ToolAuditMetadata {
  return { redact: [...new Set(redact)], category: "mcp", tags: ["mcp"] };
}
