import type { RunnerDatabase } from "../db/database.ts";
import {
  readMcpCapability,
  readMcpServer,
  type McpCapability,
  type McpRegistryOptions,
  type McpServerRegistry
} from "../mcp/registry.ts";
import { invokeMcpTransport } from "./mcpTransport.ts";
import { mcpToolProviderID } from "./mcpToolProvider.ts";
import { recordToolCallAuditEvent, type ToolCallAuditContext } from "./toolCallAudit.ts";
import type { ToolResult, ToolResultError } from "./toolProviderEnvelope.ts";

export type McpResourceReadAdapterInput = {
  auditContext?: Partial<ToolCallAuditContext>;
  capabilityID: string;
  db: RunnerDatabase;
  invocationID?: string;
  registry?: McpRegistryOptions;
};

const DEFAULT_TIMEOUT_MS = 10_000;

export function readMcpResourceWithAdapter(input: McpResourceReadAdapterInput): unknown {
  const invocationID = input.invocationID || crypto.randomUUID();
  const startedAt = new Date();
  const started = performance.now();
  const capability = readMcpCapability(input.capabilityID, input.registry);
  const server = capability ? readMcpServer(capability.server_id, input.registry) : null;
  const result = resourceResult(input, invocationID, startedAt, started, capability, server);
  auditResult(input, result, capability, server);
  return legacyResourceOutput(capability, result);
}

function resourceResult(
  input: McpResourceReadAdapterInput,
  invocationID: string,
  startedAt: Date,
  started: number,
  capability: McpCapability | null,
  server: McpServerRegistry | null
): ToolResult {
  if (!capability || capability.kind !== "resource") {
    const resultError = error("mcp_resource_not_found", "MCP resource not found");
    return finish(invocationID, startedAt, started, "failed", resultError);
  }
  if (!server) {
    const resultError = error("mcp_server_unavailable", "MCP server is not registered");
    return finish(invocationID, startedAt, started, "failed", resultError);
  }
  if (!server.transport) {
    return finish(
      invocationID,
      startedAt,
      started,
      "failed",
      error("mcp_server_unavailable", "MCP server has no executable transport")
    );
  }
  const timeoutMs = capability.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const result = invokeMcpTransport({ capability, operation: "resource.read", server, timeoutMs });
  return fixed(invocationID, startedAt, result.durationMs, result.status, result.error, result.output, {
    mcp: mcpMetadata(capability, server, timeoutMs),
    ...(result.metadata ?? {})
  });
}

function legacyResourceOutput(capability: McpCapability | null, result: ToolResult): unknown {
  if (!capability || result.status !== "succeeded") {
    return {
      ...(capability ? { capability: publicCapability(capability) } : { capability_id: "" }),
      ...(result.error ? { error: result.error } : {}),
      status: result.status
    };
  }
  const output = recordValue(result.output);
  if (Array.isArray(output.contents)) {
    return { capability: publicCapability(capability), content: output.content ?? null, contents: output.contents };
  }
  return result.output;
}

function auditResult(
  input: McpResourceReadAdapterInput,
  result: ToolResult,
  capability: McpCapability | null,
  server: McpServerRegistry | null
): void {
  recordToolCallAuditEvent(input.db, auditContext(input), {
    args: { capability_id: input.capabilityID },
    durationMs: result.duration_ms ?? 0,
    error: result.error ? { message: result.error.message, type: result.error.code ?? "tool_error" } : undefined,
    output: result.output,
    permission: capability
      ? capability.permission === "read" ? "read" : capability.permission === "write" ? "write" : "dangerous"
      : undefined,
    providerID: server ? mcpToolProviderID(server.id) : undefined,
    status: result.status,
    toolCallID: result.invocation_id,
    toolName: capability ? `resource:${capability.name}` : "resource"
  });
}

function finish(
  invocationID: string,
  startedAt: Date,
  started: number,
  status: ToolResult["status"],
  resultError?: ToolResultError,
  output?: unknown
): ToolResult {
  return fixed(invocationID, startedAt, Math.round(performance.now() - started), status, resultError, output);
}

function fixed(
  invocationID: string,
  startedAt: Date,
  durationMs: number,
  status: ToolResult["status"],
  resultError?: ToolResultError,
  output?: unknown,
  metadata?: Record<string, unknown>
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

function mcpMetadata(capability: McpCapability, server: McpServerRegistry, timeoutMs: number): Record<string, unknown> {
  return {
    capability_id: capability.id,
    provider_id: mcpToolProviderID(server.id),
    server_id: server.id,
    timeout_ms: timeoutMs,
    uri: capability.uri || capability.name
  };
}

function publicCapability(capability: McpCapability): McpCapability {
  return capability;
}

function error(code: string, message: string): ToolResultError {
  return { code, message };
}

function auditContext(input: McpResourceReadAdapterInput): ToolCallAuditContext {
  const context = input.auditContext ?? {};
  return {
    conversationID: cleanString(context.conversationID),
    delegationID: cleanString(context.delegationID),
    heartbeatID: cleanString(context.heartbeatID),
    issueID: context.issueID,
    projectID: cleanString(context.projectID),
    source: cleanString(context.source) || "mcp_resource"
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
