import { readMcpCapability, readMcpRegistry, type McpCapability } from "../mcp/registry.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { HttpError, json } from "./errors.ts";
import type { Router } from "./router.ts";

type PiMcpRegistryContext = { database?: RunnerDatabase };

export function registerPiMcpRegistryRoutes(router: Router, context: PiMcpRegistryContext = {}): void {
  router.get("/api/pi/mcp/capabilities", () => mcpCapabilitiesResponse(context));
  router.get("/api/pi/mcp/capabilities/:id", (request) => mcpCapabilityResponse(context, request));
}

function mcpCapabilitiesResponse(context: PiMcpRegistryContext): Response {
  const registry = readMcpRegistry({ database: context.database });
  return json({
    capabilities: registry.servers.flatMap((server) => server.capabilities.map(publicCapability)),
    diagnostics: registry.diagnostics,
    servers: registry.servers.map((server) => ({
      diagnostics: server.diagnostics,
      id: server.id,
      readiness: server.readiness,
      resources: server.resources.map(publicCapability),
      risk_level: server.risk_level,
      status: server.status,
      tools: server.tools.map(publicCapability)
    }))
  });
}

function mcpCapabilityResponse(context: PiMcpRegistryContext, request: Request): Response {
  const id = capabilityID(request);
  const registry = readMcpRegistry({ database: context.database });
  const capability = readMcpCapability(id, { database: context.database });
  if (!capability) throw new HttpError(404, `MCP capability 不存在: ${id}`);
  return json({ capability: publicCapability(capability), diagnostics: registry.diagnostics });
}

function capabilityID(request: Request): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const value = parts[parts.indexOf("capabilities") + 1]?.trim() ?? "";
  if (value === "") throw new HttpError(400, "MCP capability id 不能为空");
  return decodeURIComponent(value);
}

function publicCapability(capability: McpCapability): Omit<McpCapability, "content"> {
  const { content: _content, ...safe } = capability;
  return safe;
}
