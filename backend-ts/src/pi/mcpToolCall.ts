import type { RunnerDatabase } from "../db/database.ts";
import {
  isMcpServerAuthorized,
  readMcpCapability,
  readMcpServer,
  type McpCapability,
  type McpRegistryOptions,
  type McpServerRegistry
} from "../mcp/registry.ts";
import { recordToolCallAuditEvent, type ToolCallAuditContext } from "./toolCallAudit.ts";
import { mcpToolProviderID } from "./mcpToolProvider.ts";
import { invokeMcpTransport } from "./mcpTransport.ts";
import type { ToolPermission, ToolResult, ToolResultError } from "./toolProviderEnvelope.ts";

export const MCP_TOOL_ERROR_CODES = {
  capabilityNotTool: "mcp_capability_not_tool",
  permissionDenied: "permission_denied",
  schemaMismatch: "mcp_schema_mismatch",
  serverUnavailable: "mcp_server_unavailable",
  spawnError: "mcp_spawn_error",
  toolError: "mcp_tool_error",
  toolNotFound: "mcp_tool_not_found",
  timeout: "mcp_timeout"
} as const;

export type McpToolCallInput = {
  auditContext?: Partial<ToolCallAuditContext>;
  auditProviderID?: string;
  auditToolName?: string;
  db: RunnerDatabase;
  input?: Record<string, unknown>;
  invocationID?: string;
  maxPermission?: ToolPermission;
  registry?: McpRegistryOptions;
  timeoutMs?: number;
  capabilityID: string;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const PERMISSION_LEVEL: Record<ToolPermission, number> = { read: 0, write: 1, dangerous: 2 };

export function callMcpTool(request: McpToolCallInput): ToolResult {
  const invocationID = request.invocationID || crypto.randomUUID();
  const startedAt = new Date();
  const started = performance.now();
  const capability = readMcpCapability(request.capabilityID, request.registry);
  const server = capability ? readMcpServer(capability.server_id, request.registry) : null;
  const result = mcpToolResult(request, invocationID, startedAt, started, capability, server);
  return auditResult(request, result, capability, server);
}

function mcpToolResult(
  request: McpToolCallInput,
  invocationID: string,
  startedAt: Date,
  started: number,
  capability: McpCapability | null,
  server: McpServerRegistry | null
): ToolResult {
  if (!capability) {
    const message = `MCP tool not found: ${request.capabilityID}`;
    return timedResult(invocationID, startedAt, started, "failed", toolError("toolNotFound", message));
  }
  if (capability.kind !== "tool") {
    const message = `MCP capability is not a tool: ${capability.id}`;
    return timedResult(invocationID, startedAt, started, "failed", toolError("capabilityNotTool", message));
  }
  if (!server || !isMcpServerAuthorized(server)) {
    return timedResult(invocationID, startedAt, started, "denied", toolError("serverUnavailable", "MCP server is not authorized or ready"));
  }
  if (!permissionAllows(request.maxPermission ?? "dangerous", assistantPermission(capability))) {
    const message = `Permission ${assistantPermission(capability)} is required to call this MCP tool`;
    return timedResult(invocationID, startedAt, started, "denied", toolError("permissionDenied", message));
  }
  if (server.transport) return executeTransportTool(request, invocationID, startedAt, capability, server);
  return timedResult(
    invocationID,
    startedAt,
    started,
    "failed",
    toolError("serverUnavailable", "MCP server has no executable transport")
  );
}

function executeTransportTool(
  request: McpToolCallInput,
  invocationID: string,
  startedAt: Date,
  capability: McpCapability,
  server: McpServerRegistry
): ToolResult {
  const timeoutMs = request.timeoutMs ?? capability.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const result = invokeMcpTransport({
    capability,
    input: request.input ?? {},
    operation: "tool.call",
    server,
    timeoutMs
  });
  const metadata = {
    ...mcpMetadata(capability, server, timeoutMs),
    ...(result.metadata ?? {})
  };
  return fixedDurationResult(
    invocationID,
    startedAt,
    result.durationMs,
    result.status,
    metadata,
    result.error,
    result.output
  );
}

function auditResult(
  request: McpToolCallInput,
  result: ToolResult,
  capability: McpCapability | null,
  server: McpServerRegistry | null
): ToolResult {
  recordToolCallAuditEvent(request.db, auditContext(request), {
    args: request.input ?? {},
    durationMs: result.duration_ms ?? 0,
    error: result.error ? { message: result.error.message, type: result.error.code ?? "tool_error" } : undefined,
    output: result.output,
    providerID: cleanString(request.auditProviderID) || (server ? mcpToolProviderID(server.id) : undefined),
    status: result.status,
    toolCallID: result.invocation_id,
    toolName: cleanString(request.auditToolName) || (capability?.name ?? request.capabilityID)
  });
  return result;
}

function timedResult(
  invocationID: string,
  startedAt: Date,
  started: number,
  status: ToolResult["status"],
  resultError: ToolResultError
): ToolResult {
  return fixedDurationResult(invocationID, startedAt, Math.round(performance.now() - started), status, undefined, resultError);
}

function fixedDurationResult(
  invocationID: string,
  startedAt: Date,
  durationMs: number,
  status: ToolResult["status"],
  metadata?: Record<string, unknown>,
  resultError?: ToolResultError,
  output?: unknown
): ToolResult {
  return {
    duration_ms: Math.max(0, Math.round(durationMs)),
    ended_at: new Date(startedAt.getTime() + Math.max(0, Math.round(durationMs))).toISOString(),
    invocation_id: invocationID,
    started_at: startedAt.toISOString(),
    status,
    ...(output === undefined ? {} : { output }),
    ...(resultError === undefined ? {} : { error: resultError }),
    ...(metadata === undefined ? {} : { metadata })
  };
}

function toolError(code: keyof typeof MCP_TOOL_ERROR_CODES, message: string, details?: unknown): ToolResultError {
  return { code: MCP_TOOL_ERROR_CODES[code], message, ...(details === undefined ? {} : { details }) };
}

function mcpMetadata(capability: McpCapability, server: McpServerRegistry, timeoutMs: number): Record<string, unknown> {
  return {
    mcp: {
      capability_id: capability.id,
      provider_id: mcpToolProviderID(server.id),
      server_id: server.id,
      timeout_ms: timeoutMs,
      tool_name: capability.name
    }
  };
}

function auditContext(request: McpToolCallInput): ToolCallAuditContext {
  const context = request.auditContext ?? {};
  return {
    conversationID: cleanString(context.conversationID),
    delegationID: cleanString(context.delegationID),
    heartbeatID: cleanString(context.heartbeatID),
    issueID: context.issueID,
    projectID: cleanString(context.projectID),
    source: cleanString(context.source) || "mcp_tool"
  };
}

function assistantPermission(capability: McpCapability): ToolPermission {
  if (capability.permission === "admin" || capability.risk_level === "high") return "dangerous";
  if (capability.permission === "write" || capability.risk_level === "medium") return "write";
  return "read";
}

function permissionAllows(max: ToolPermission, required: ToolPermission): boolean {
  return PERMISSION_LEVEL[max] >= PERMISSION_LEVEL[required];
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
