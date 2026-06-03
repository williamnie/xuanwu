import { afterEach, describe, expect, test } from "bun:test";
import { listMcpRegistry, readMcpCapability, recommendMcpRequirements } from "./registry.ts";

const previousRegistry = Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON;

afterEach(() => {
  if (previousRegistry === undefined) delete Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON;
  else Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON = previousRegistry;
});

describe("PI MCP capability registry", () => {
  test("normalizes configured MCP servers into discoverable capabilities", () => {
    Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON = JSON.stringify({ servers: [docsServer()] });

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
  });

  test("recommends MCP requirements from issue text", () => {
    Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON = JSON.stringify({ servers: [docsServer()] });

    const recommended = recommendMcpRequirements({
      description: "Find the deployment runbook before changing production docs.",
      title: "Deployment runbook lookup"
    });

    expect(recommended.map((item) => item.id)).toContain("docs:resource:runbook");
    expect(recommended[0]).toMatchObject({ reason: expect.stringContaining("runbook") });
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
