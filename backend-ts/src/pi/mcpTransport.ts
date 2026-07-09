import { spawnSync } from "node:child_process";
import type { McpCapability, McpServerRegistry } from "../mcp/registry.ts";
import type { ToolResult, ToolResultError } from "./toolProviderEnvelope.ts";

export const MCP_TRANSPORT_ERROR_CODES = {
  schemaMismatch: "mcp_schema_mismatch",
  serverUnavailable: "mcp_server_unavailable",
  spawnError: "mcp_spawn_error",
  timeout: "mcp_timeout",
  toolError: "mcp_tool_error"
} as const;

export type McpTransportOperation = "resource.read" | "tool.call";
export type McpTransportInvokeRequest = {
  capability: McpCapability;
  input?: Record<string, unknown>;
  operation: McpTransportOperation;
  server: McpServerRegistry;
  timeoutMs: number;
};
export type McpTransportInvokeResult = Pick<ToolResult, "error" | "metadata" | "output" | "status"> & {
  durationMs: number;
};

type JsonRpcMessage = {
  error?: { code?: unknown; data?: unknown; message?: unknown };
  id?: number | string;
  jsonrpc?: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
};

const INITIALIZE_ID = 1;
const INVOKE_ID = 2;
const STDOUT_LIMIT = 64 * 1024;
const STDERR_LIMIT = 8 * 1024;

export function invokeMcpTransport(request: McpTransportInvokeRequest): McpTransportInvokeResult {
  const started = performance.now();
  const transport = request.server.transport;
  if (!transport) return failed(started, error("serverUnavailable", "MCP server transport is not configured"));
  const outcome = spawnSync(transport.command, transport.args, {
    cwd: transport.cwd,
    encoding: "utf8",
    env: transportEnv(transport.env),
    input: requestPayload(request),
    maxBuffer: STDOUT_LIMIT + STDERR_LIMIT,
    shell: false,
    timeout: request.timeoutMs
  });
  const metadata = transportMetadata(request, outcome);
  if (timedOut(outcome.error)) {
    return failed(started, error("timeout", "MCP transport timed out", metadata.mcp_transport), metadata, "timeout");
  }
  if (outcome.error) {
    return failed(started, error("spawnError", safeMessage(outcome.error), metadata.mcp_transport), metadata);
  }
  if (outcome.status !== 0) {
    const resultError = error("serverUnavailable", "MCP server exited with a non-zero status", metadata.mcp_transport);
    return failed(started, resultError, metadata);
  }
  const response = invocationResponse(outcome.stdout);
  if ("error" in response) return failed(started, response.error, metadata);
  return resultFromRpcResult(request, response.result, metadata, started);
}

function requestPayload(request: McpTransportInvokeRequest): string {
  return [
    rpcRequest(INITIALIZE_ID, "initialize", initializeParams()),
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    rpcRequest(INVOKE_ID, methodName(request), invokeParams(request))
  ].map((message) => JSON.stringify(message)).join("\n") + "\n";
}

function rpcRequest(id: number, method: string, params: Record<string, unknown>): JsonRpcMessage {
  return { id, jsonrpc: "2.0", method, params };
}

function initializeParams(): Record<string, unknown> {
  return {
    capabilities: {},
    clientInfo: { name: "codex-issue-runner", version: "0.0.0" },
    protocolVersion: "2024-11-05"
  };
}

function methodName(request: McpTransportInvokeRequest): string {
  return request.operation === "tool.call" ? "tools/call" : "resources/read";
}

function invokeParams(request: McpTransportInvokeRequest): Record<string, unknown> {
  if (request.operation === "tool.call") {
    return { arguments: request.input ?? {}, name: request.capability.name };
  }
  return { uri: request.capability.uri || request.capability.name };
}

function invocationResponse(stdout: string): { result: unknown } | { error: ToolResultError } {
  const messages = parseMessages(stdout);
  if ("error" in messages) return messages;
  const response = messages.items.find((message) => message.id === INVOKE_ID);
  if (!response) return { error: error("schemaMismatch", "MCP response did not include invocation result") };
  if (response.error) return { error: rpcError(response.error) };
  if (response.result === undefined) return { error: error("schemaMismatch", "MCP response result is missing") };
  return { result: response.result };
}

function parseMessages(stdout: string): { items: JsonRpcMessage[] } | { error: ToolResultError } {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const items: JsonRpcMessage[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isRecord(parsed)) items.push(parsed as JsonRpcMessage);
    } catch {
      return { error: error("schemaMismatch", "MCP stdout was not valid JSON-RPC") };
    }
  }
  return { items };
}

function resultFromRpcResult(
  request: McpTransportInvokeRequest,
  result: unknown,
  metadata: Record<string, unknown>,
  started: number
): McpTransportInvokeResult {
  if (request.operation === "tool.call") return toolResult(result, metadata, started);
  return resourceResult(result, metadata, started);
}

function toolResult(result: unknown, metadata: Record<string, unknown>, started: number): McpTransportInvokeResult {
  const object = recordValue(result);
  const content = Array.isArray(object.content) ? object.content : [];
  if (object.isError === true) {
    return failed(started, error("toolError", contentText(content) || "MCP tool call failed"), metadata);
  }
  if (object.structuredContent !== undefined) return succeeded(started, object.structuredContent, metadata);
  if (content.length === 0) {
    return failed(started, error("schemaMismatch", "MCP tool result content is missing"), metadata);
  }
  return succeeded(started, contentOutput(content), metadata);
}

function resourceResult(result: unknown, metadata: Record<string, unknown>, started: number): McpTransportInvokeResult {
  const object = recordValue(result);
  const contents = Array.isArray(object.contents) ? object.contents.map(resourceContent) : [];
  if (contents.length === 0) {
    return failed(started, error("schemaMismatch", "MCP resource result contents are missing"), metadata);
  }
  return succeeded(started, { content: firstResourceText(contents), contents }, metadata);
}

function contentOutput(content: unknown[]): unknown {
  if (content.length !== 1) return content;
  const item = recordValue(content[0]);
  if (cleanString(item.type) === "text" && typeof item.text === "string") return jsonOrText(item.text);
  return content[0];
}

function resourceContent(value: unknown): Record<string, unknown> {
  const item = recordValue(value);
  return {
    ...(item.blob === undefined ? {} : { blob: item.blob }),
    ...(item.mimeType === undefined ? {} : { mimeType: item.mimeType }),
    ...(item.text === undefined ? {} : { text: item.text }),
    uri: cleanString(item.uri)
  };
}

function firstResourceText(contents: Record<string, unknown>[]): unknown {
  const first = contents.find((item) => typeof item.text === "string");
  return first?.text ?? null;
}

function contentText(content: unknown[]): string {
  return content.map((item) => cleanString(recordValue(item).text)).filter(Boolean).join("\n");
}

function succeeded(started: number, output: unknown, metadata: Record<string, unknown>): McpTransportInvokeResult {
  return { durationMs: duration(started), metadata, output, status: "succeeded" };
}

function failed(
  started: number,
  resultError: ToolResultError,
  metadata?: Record<string, unknown>,
  status: "failed" | "timeout" = "failed"
): McpTransportInvokeResult {
  return { durationMs: duration(started), error: resultError, ...(metadata ? { metadata } : {}), status };
}

function error(code: keyof typeof MCP_TRANSPORT_ERROR_CODES, message: string, details?: unknown): ToolResultError {
  return { code: MCP_TRANSPORT_ERROR_CODES[code], message, ...(details === undefined ? {} : { details }) };
}

function rpcError(value: { code?: unknown; data?: unknown; message?: unknown }): ToolResultError {
  return error("toolError", cleanString(value.message) || "MCP tool call failed", {
    mcp_code: value.code,
    ...(value.data === undefined ? {} : { data: value.data })
  });
}

function transportMetadata(
  request: McpTransportInvokeRequest,
  outcome: ReturnType<typeof spawnSync>
): Record<string, unknown> {
  return {
    mcp_transport: {
      args: request.server.transport?.args ?? [],
      command: request.server.transport?.command ?? "",
      exit_code: outcome.status,
      signal: outcome.signal,
      stderr: truncate(cleanString(outcome.stderr), STDERR_LIMIT),
      stdout_bytes: cleanString(outcome.stdout).length,
      timeout_ms: request.timeoutMs,
      type: request.server.transport?.type ?? "unknown"
    }
  };
}

function transportEnv(env: Record<string, string> | undefined): Record<string, string | undefined> {
  return {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    ...(env ?? {})
  };
}

function timedOut(value: unknown): boolean {
  return isRecord(value) && cleanString(value.code) === "ETIMEDOUT";
}

function safeMessage(value: unknown): string {
  return value instanceof Error ? value.message : cleanString(value) || "MCP transport failed";
}

function jsonOrText(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function duration(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
