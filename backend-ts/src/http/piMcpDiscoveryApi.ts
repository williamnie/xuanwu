import { listPiMcpCapabilities, patchPiMcpCapability, replacePiMcpCapabilitiesForServer } from "../db/repositories/piMcpCapabilities.ts";
import { deletePiMcpServer, getPiMcpServer, listPiMcpServers, normalizeID, patchPiMcpServer, redactionFor, upsertPiMcpServer, type PiMcpServer, type PiMcpServerInput } from "../db/repositories/piMcpServers.ts";
import { listMcpDiscoverySources, scanMcpDiscoverySources } from "../mcp/discovery/detectors.ts";
import { introspectMcpServer } from "../mcp/discovery/introspector.ts";
import type { McpDiscoveryServer, McpDiscoveryTransport } from "../mcp/discovery/types.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";
import type { RunnerDatabase } from "../db/database.ts";

type PiMcpDiscoveryContext = { database: RunnerDatabase };

export function registerPiMcpDiscoveryRoutes(router: Router, context: PiMcpDiscoveryContext): void {
  router.get("/api/pi/mcp/discovery/sources", () => sourcesResponse());
  router.post("/api/pi/mcp/discovery/scan", (request) => scanResponse(context, request));
  router.get("/api/pi/mcp/discovery/results", () => resultsResponse(context));
  router.post("/api/pi/mcp/servers", (request) => createServerResponse(context, request));
  router.patch("/api/pi/mcp/servers/:id", (request) => patchServerResponse(context, request));
  router.delete("/api/pi/mcp/servers/:id", (request) => deleteServerResponse(context, request));
  router.post("/api/pi/mcp/servers/:id/introspect", (request) => introspectResponse(context, request));
  router.patch("/api/pi/mcp/capabilities/:id", (request) => patchCapabilityResponse(context, request));
}

function sourcesResponse(): Response {
  return json({ sources: listMcpDiscoverySources() });
}

async function scanResponse(context: PiMcpDiscoveryContext, request: Request): Promise<Response> {
  const body = objectValue(await parseJsonBody(request));
  const scan = await scanMcpDiscoverySources({ sources: stringList(body.sources), workspaceDir: stringInput(body.workspace_dir ?? body.workspaceDir) });
  const now = new Date().toISOString();
  const servers = scan.servers.map((server) => upsertPiMcpServer(context.database, serverInput(server, now)));
  return json(redactSecrets({ diagnostics: scan.diagnostics, scan_id: crypto.randomUUID(), servers: servers.map(publicServer) }));
}

function resultsResponse(context: PiMcpDiscoveryContext): Response {
  const servers = listPiMcpServers(context.database).map(publicServer);
  const capabilities = listPiMcpCapabilities(context.database).map(publicCapability);
  return json(redactSecrets({ capabilities, servers }));
}

async function createServerResponse(context: PiMcpDiscoveryContext, request: Request): Promise<Response> {
  const input = manualServerInput(objectValue(await parseJsonBody(request)));
  const server = upsertPiMcpServer(context.database, input);
  return json(redactSecrets({ server: publicServer(server) }));
}

async function patchServerResponse(context: PiMcpDiscoveryContext, request: Request): Promise<Response> {
  const server = patchPiMcpServer(context.database, pathID(request, "servers"), patchInput(objectValue(await parseJsonBody(request))));
  if (!server) throw new HttpError(404, "MCP server 不存在");
  return json(redactSecrets({ server: publicServer(server) }));
}

function deleteServerResponse(context: PiMcpDiscoveryContext, request: Request): Response {
  if (!deletePiMcpServer(context.database, pathID(request, "servers"))) throw new HttpError(404, "MCP server 不存在");
  return json({ ok: true });
}

function introspectResponse(context: PiMcpDiscoveryContext, request: Request): Response {
  const id = pathID(request, "servers");
  const server = getPiMcpServer(context.database, id);
  if (!server) throw new HttpError(404, "MCP server 不存在");
  const result = introspectMcpServer(server);
  const capabilities = replacePiMcpCapabilitiesForServer(context.database, id, result.capabilities);
  const updated = patchPiMcpServer(context.database, id, {
    diagnostics: result.diagnostics, last_introspected_at: new Date().toISOString(), metadata: { ...server.metadata, server_info: result.serverInfo ?? {} },
    readiness: result.readiness, status: result.status
  });
  return json(redactSecrets({ capabilities: capabilities.map(publicCapability), diagnostics: result.diagnostics, server: updated && publicServer(updated) }));
}

async function patchCapabilityResponse(context: PiMcpDiscoveryContext, request: Request): Promise<Response> {
  const capability = patchPiMcpCapability(context.database, pathID(request, "capabilities"), capabilityPatch(objectValue(await parseJsonBody(request))));
  if (!capability) throw new HttpError(404, "MCP capability 不存在");
  return json(redactSecrets({ capability: publicCapability(capability) }));
}

function serverInput(server: McpDiscoveryServer, now: string): PiMcpServerInput {
  const transport = server.transport;
  return { args: transport.type === "stdio" ? transport.args ?? [] : [], command: transport.type === "stdio" ? transport.command : "",
    cwd: transport.type === "stdio" ? transport.cwd : "", description: server.description, diagnostics: server.diagnostics ?? [],
    env: transport.type === "stdio" ? transport.env ?? {} : {}, headers: transport.type === "stdio" ? {} : transport.headers ?? {},
    id: server.id, last_scan_at: now, metadata: server.metadata ?? {}, name: server.name, readiness: "not_introspected",
    risk_level: server.risk_level ?? "medium", source: server.source, source_path: server.source_path, status: "discovered",
    transport_type: transport.type, url: transport.type === "stdio" ? "" : transport.url };
}

function manualServerInput(body: Record<string, unknown>): PiMcpServerInput {
  const name = stringInput(body.name) || "Manual MCP";
  const transport = transportInput(objectValue(body.transport));
  return { ...transportFields(transport), description: stringInput(body.description), id: stringInput(body.id) || normalizeID(name),
    name, readiness: "not_introspected", redaction: redactionFor(transportEnv(transport), transportHeaders(transport)),
    risk_level: "medium", source: "manual", source_path: "manual", status: "configured" };
}

function patchInput(body: Record<string, unknown>): Partial<PiMcpServerInput> {
  const transport = body.transport === undefined ? undefined : transportInput(objectValue(body.transport));
  return { ...(body.enabled === undefined ? {} : { enabled: body.enabled === true }), ...(body.name === undefined ? {} : { name: stringInput(body.name) }),
    ...(transport ? transportFields(transport) : {}) };
}

function transportInput(raw: Record<string, unknown>): McpDiscoveryTransport {
  const type = stringInput(raw.type).toLowerCase();
  if (type === "http" || type === "sse" || type === "streamable_http") return { headers: stringRecord(raw.headers), type, url: stringInput(raw.url) };
  return { args: stringList(raw.args), command: stringInput(raw.command), cwd: stringInput(raw.cwd), env: stringRecord(raw.env), type: "stdio" };
}

function transportFields(transport: McpDiscoveryTransport): Partial<PiMcpServerInput> {
  if (transport.type === "stdio") return { args: transport.args ?? [], command: transport.command, cwd: transport.cwd, env: transport.env ?? {}, transport_type: "stdio" };
  return { headers: transport.headers ?? {}, transport_type: transport.type, url: transport.url };
}

function capabilityPatch(body: Record<string, unknown>) {
  return { ...(body.enabled === undefined ? {} : { enabled: body.enabled === true }),
    ...(body.permission === undefined ? {} : { permission: stringInput(body.permission) as "read" | "write" | "admin" }),
    ...(body.read_only === undefined ? {} : { read_only: body.read_only === true }),
    ...(body.requires_confirmation === undefined ? {} : { requires_confirmation: body.requires_confirmation === true }),
    ...(body.risk_level === undefined ? {} : { risk_level: stringInput(body.risk_level) as "low" | "medium" | "high" }),
    ...(body.timeout_ms === undefined ? {} : { timeout_ms: numberInput(body.timeout_ms) }) };
}

function publicServer(server: PiMcpServer): Record<string, unknown> {
  return { ...server, transport: { args: server.args, command: server.command, cwd: server.cwd, env: redactRecord(server.env),
    headers: redactRecord(server.headers), type: server.transport_type, url: server.url } };
}

function publicCapability(capability: unknown): unknown {
  return capability;
}

function pathID(request: Request, marker: string): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const value = parts[parts.indexOf(marker) + 1]?.trim() ?? "";
  if (!value) throw new HttpError(400, "id 不能为空");
  return decodeURIComponent(value);
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sensitiveKey(key) ? redactValue(child) : redactSecrets(child)]));
}

function redactValue(value: unknown): unknown {
  if (isRecord(value)) return redactRecord(value as Record<string, string>);
  if (Array.isArray(value)) return value.map(() => "[redacted]");
  return value === "" || value === undefined ? value : "[redacted]";
}

function redactRecord(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(value).map((key) => [key, value[key] ? "[redacted]" : ""]));
}

function transportEnv(transport: McpDiscoveryTransport): Record<string, string> {
  return transport.type === "stdio" ? transport.env ?? {} : {};
}

function transportHeaders(transport: McpDiscoveryTransport): Record<string, string> {
  return transport.type === "stdio" ? {} : transport.headers ?? {};
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(stringInput).filter(Boolean);
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [stringInput(key), stringInput(child)]).filter(([key]) => key));
}

function objectValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringInput(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberInput(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function sensitiveKey(key: string): boolean {
  return /secret|token|password|passwd|credential|api[_-]?key|authorization|auth|env|headers/i.test(key);
}
