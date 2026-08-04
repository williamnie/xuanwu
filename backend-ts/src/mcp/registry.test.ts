import { afterEach, describe, expect, test } from "bun:test";
import {
  listMcpRegistry,
  listMcpResources,
  readMcpCapability,
  readMcpRegistry,
  recommendMcpRequirements
} from "./registry.ts";

const previousRegistry = Bun.env.XUANWU_MCP_REGISTRY_JSON;

afterEach(() => {
  if (previousRegistry === undefined) delete Bun.env.XUANWU_MCP_REGISTRY_JSON;
  else Bun.env.XUANWU_MCP_REGISTRY_JSON = previousRegistry;
});

describe("PI MCP capability registry", () => {
  test("normalizes configured MCP servers into discoverable capabilities", () => {
    Bun.env.XUANWU_MCP_REGISTRY_JSON = JSON.stringify({ servers: [docsServer()] });

    const registry = listMcpRegistry();
    const capabilityIDs = registry.flatMap((server) => server.capabilities.map((capability) => capability.id));

    expect(registry[0]).toMatchObject({
      id: "docs",
      readiness: "ready",
      risk_level: "low",
      status: "enabled"
    });
    expect(capabilityIDs).toEqual(expect.arrayContaining([
      "docs:resource:runbook",
      "docs:resource:secret",
      "docs:tool:search",
      "docs:tool:delete_doc"
    ]));
    expect(readMcpCapability("docs:resource:runbook")).toMatchObject({
      allowed_actions: ["mcp.resource.read"],
      read_only: true,
      requires_confirmation: false,
      risk_level: "low"
    });
    expect(readMcpCapability("docs:tool:delete_doc")).toMatchObject({
      permission: "write",
      requires_confirmation: true,
      risk_level: "high"
    });
    expect(readMcpCapability("docs:tool:search")).not.toHaveProperty("content");
    expect(readMcpCapability("docs:tool:search")).not.toHaveProperty("invocation");
  });

  test("recommends MCP requirements from issue text", () => {
    Bun.env.XUANWU_MCP_REGISTRY_JSON = JSON.stringify({ servers: [docsServer()] });

    const recommended = recommendMcpRequirements({
      description: "Find the deployment runbook before changing production docs.",
      title: "Deployment runbook lookup"
    });

    expect(recommended.map((item) => item.id)).toContain("docs:resource:runbook");
    expect(recommended[0]).toMatchObject({ reason: expect.stringContaining("runbook") });
  });
  test("reports unavailable server readiness diagnostics", () => {
    Bun.env.XUANWU_MCP_REGISTRY_JSON = JSON.stringify({ servers: [{
      id: "offline-docs",
      status: "unavailable",
      readiness: "auth_missing",
      resources: [{ name: "runbook", description: "Deployment runbook" }]
    }] });

    const registry = readMcpRegistry();

    expect(registry.servers[0]).toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "server_unavailable", server_id: "offline-docs" }),
        expect.objectContaining({ code: "server_not_ready", readiness: "auth_missing" })
      ]),
      id: "offline-docs",
      readiness: "auth_missing",
      status: "unavailable"
    });
    expect(registry.diagnostics).toEqual(registry.servers[0].diagnostics);
  });

  test("lists only authorized read-only resources", () => {
    Bun.env.XUANWU_MCP_REGISTRY_JSON = JSON.stringify({ servers: [docsServer(), {
      id: "offline-docs",
      status: "unavailable",
      readiness: "auth_missing",
      resources: [{ name: "guide", description: "Offline guide", content: "must not leak" }]
    }] });

    expect(listMcpResources().map((item) => item.id)).toEqual(["docs:resource:runbook"]);
    expect(listMcpResources("offline-docs")).toEqual([]);
    expect(readMcpCapability("docs:resource:runbook")).toMatchObject({ id: "docs:resource:runbook", read_only: true });
    expect(readMcpCapability("docs:resource:secret")).toMatchObject({ id: "docs:resource:secret", read_only: false });
  });

});

function docsServer() {
  return {
    id: "docs",
    status: "enabled",
    readiness: "ready",
    permissions: ["read"],
    risk_level: "low",
    resources: [
      { name: "runbook", description: "Deployment runbook and operations guide", content: "deploy safely" },
      { name: "secret", description: "Sensitive vault record", permission: "admin", risk_level: "high" }
    ],
    tools: [
      { name: "search", description: "Search documentation", permission: "read", risk_level: "low" },
      { name: "delete_doc", description: "Delete documentation", permission: "write", risk_level: "high" }
    ]
  };
}
