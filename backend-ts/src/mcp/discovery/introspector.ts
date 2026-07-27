import { spawnSync } from "node:child_process";
import type { PiMcpCapabilityInput } from "../../db/repositories/piMcpCapabilities.ts";
import type { PiMcpServer } from "../../db/repositories/piMcpServers.ts";

export type McpIntrospectionResult = {
  capabilities: PiMcpCapabilityInput[];
  diagnostics: { code: string; message: string; severity: "warning" | "error"; details?: unknown }[];
  readiness: string;
  serverInfo?: Record<string, unknown>;
  status: string;
};

type JsonRpcMessage = { error?: { message?: unknown }; id?: number | string; result?: unknown };

const TIMEOUT_MS = 5000;
const MAX_BUFFER = 96 * 1024;

export function introspectMcpServer(server: PiMcpServer): McpIntrospectionResult {
  if (server.transport_type !== "stdio") return unsupportedTransport(server);
  if (!server.command) return failed("mcp_stdio_command_missing", "stdio MCP server command is missing");
  const outcome = spawnSync(server.command, server.args, {
    cwd: server.cwd || undefined,
    encoding: "utf8",
    env: transportEnv(server.env),
    input: requestPayload(),
    maxBuffer: MAX_BUFFER,
    shell: false,
    timeout: TIMEOUT_MS
  });
  if (timedOut(outcome.error)) return failed("mcp_introspection_timeout", "MCP introspection timed out");
  if (outcome.error) return failed("mcp_introspection_spawn_error", safeMessage(outcome.error));
  if (outcome.status !== 0) return failed("mcp_introspection_exit_nonzero", "MCP server exited with a non-zero status", { stderr: truncate(outcome.stderr) });
  return resultFromStdout(server, outcome.stdout);
}

function unsupportedTransport(server: PiMcpServer): McpIntrospectionResult {
  return failed("mcp_transport_unsupported", `MCP ${server.transport_type} introspection is not supported yet`, { transport_type: server.transport_type, url: server.url });
}

function resultFromStdout(server: PiMcpServer, stdout: string): McpIntrospectionResult {
  const parsed = parseMessages(stdout);
  if ("diagnostic" in parsed) return failed(parsed.diagnostic.code, parsed.diagnostic.message);
  const initialize = response(parsed.items, 1);
  const tools = response(parsed.items, 2);
  const resources = response(parsed.items, 3);
  const errors = [initialize, tools, resources].filter((item) => item?.error).map((item) => clean(item?.error?.message));
  if (errors.length) return failed("mcp_introspection_rpc_error", errors.join("; "));
  return {
    capabilities: [...toolCapabilities(server, tools?.result), ...resourceCapabilities(server, resources?.result)],
    diagnostics: [],
    readiness: "ready",
    serverInfo: record(record(initialize?.result).serverInfo),
    status: "available"
  };
}

function toolCapabilities(server: PiMcpServer, result: unknown): PiMcpCapabilityInput[] {
  return arrayValue(record(result).tools).map((item) => toolCapability(server, record(item))).filter(Boolean) as PiMcpCapabilityInput[];
}

function resourceCapabilities(server: PiMcpServer, result: unknown): PiMcpCapabilityInput[] {
  return arrayValue(record(result).resources).map((item) => resourceCapability(server, record(item))).filter(Boolean) as PiMcpCapabilityInput[];
}

function toolCapability(server: PiMcpServer, raw: Record<string, unknown>): PiMcpCapabilityInput | null {
  const name = clean(raw.name);
  if (!name) return null;
  const annotations = record(raw.annotations);
  const readOnly = annotations.readOnlyHint === true;
  const highRisk = annotations.destructiveHint === true || annotations.openWorldHint === true;
  return { description: clean(raw.description), input_schema: schema(raw.inputSchema ?? raw.input_schema), kind: "tool",
    metadata: { annotations }, name, output_schema: schema(raw.outputSchema ?? raw.output_schema),
    permission: readOnly ? "read" : "write", read_only: readOnly,
    requires_confirmation: highRisk, risk_level: readOnly ? "low" : highRisk ? "high" : "medium",
    server_id: server.id, source_path: server.source_path,
    timeout_ms: 10000 };
}

function resourceCapability(server: PiMcpServer, raw: Record<string, unknown>): PiMcpCapabilityInput | null {
  const name = clean(raw.name || raw.uri);
  const uri = clean(raw.uri);
  if (!name && !uri) return null;
  return { description: clean(raw.description), kind: "resource", name: name || uri, permission: "read",
    read_only: true, requires_confirmation: false, risk_level: "low", server_id: server.id,
    source_path: server.source_path, timeout_ms: 10000, uri };
}

function requestPayload(): string {
  return [rpc(1, "initialize"), { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    rpc(2, "tools/list"), rpc(3, "resources/list")].map((item) => JSON.stringify(item)).join("\n") + "\n";
}

function rpc(id: number, method: string): Record<string, unknown> {
  return { id, jsonrpc: "2.0", method, params: method === "initialize" ? initializeParams() : {} };
}

function initializeParams(): Record<string, unknown> {
  return { capabilities: {}, clientInfo: { name: "codex-issue-runner-pi", version: "0.0.0" }, protocolVersion: "2024-11-05" };
}

function parseMessages(stdout: string): { items: JsonRpcMessage[] } | { diagnostic: { code: string; message: string } } {
  const items = [];
  for (const line of stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
    try { const parsed = JSON.parse(line); if (parsed && typeof parsed === "object") items.push(parsed as JsonRpcMessage); }
    catch { return { diagnostic: { code: "mcp_introspection_schema_mismatch", message: "MCP stdout was not valid JSON-RPC" } }; }
  }
  return { items };
}

function response(items: JsonRpcMessage[], id: number): JsonRpcMessage | undefined {
  return items.find((item) => item.id === id);
}

function failed(code: string, message: string, details?: unknown): McpIntrospectionResult {
  return { capabilities: [], diagnostics: [{ code, details, message, severity: "warning" }], readiness: code.includes("unsupported") ? "unsupported" : "failed", status: "failed" };
}

function transportEnv(env: Record<string, string>): Record<string, string | undefined> {
  return { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, ...env };
}

function schema(value: unknown): Record<string, unknown> {
  const object = record(value);
  return Object.keys(object).length ? object : { type: "object" };
}

function timedOut(value: unknown): boolean {
  return value instanceof Error && "code" in value && value.code === "ETIMEDOUT";
}

function safeMessage(value: unknown): string {
  return value instanceof Error ? value.message : "MCP introspection failed";
}

function truncate(value: unknown): string {
  const text = clean(value);
  return text.length > 4096 ? `${text.slice(0, 4096)}…` : text;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
