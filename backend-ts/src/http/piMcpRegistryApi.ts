import { readMcpCapability, readMcpRegistry, type McpCapability } from "../mcp/registry.ts";
import { HttpError, json } from "./errors.ts";
import type { Router } from "./router.ts";

export function registerPiMcpRegistryRoutes(router: Router): void {
  router.get("/api/pi/mcp/capabilities", () => mcpCapabilitiesResponse());
  router.get("/api/pi/mcp/capabilities/:id", (request) => mcpCapabilityResponse(request));
}

function mcpCapabilitiesResponse(): Response {
  const registry = readMcpRegistry();
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

function mcpCapabilityResponse(request: Request): Response {
  const id = capabilityID(request);
  const registry = readMcpRegistry();
  const capability = readMcpCapability(id);
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
