import { describe, expect, test } from "bun:test";
import { classifyPiActionRisk, gatePiActionEnvelope } from "./actionEngine.ts";

describe("PI action engine risk classifier", () => {
  test("classifies safe, confirm-required, and high-risk actions", () => {
    expect(classifyPiActionRisk("issue.comment")).toEqual({
      gate: "safe",
      requiresConfirmation: false,
      riskLevel: "low"
    });
    expect(classifyPiActionRisk("issue.enqueue")).toEqual({
      gate: "confirm",
      requiresConfirmation: true,
      riskLevel: "medium"
    });
    expect(classifyPiActionRisk("session.steer")).toEqual({
      gate: "high",
      requiresConfirmation: true,
      riskLevel: "high"
    });
    expect(classifyPiActionRisk("mcp.resource.read")).toEqual({
      gate: "safe",
      requiresConfirmation: false,
      riskLevel: "low"
    });
    expect(classifyPiActionRisk("mcp.tool.call", { riskLevel: "high" })).toEqual({
      gate: "high",
      requiresConfirmation: true,
      riskLevel: "high"
    });
  });

  test("gates attended confirmations and delegated authorization envelopes", () => {
    const confirmEnvelope = {
      action_type: "issue.enqueue",
      issue_id: 7,
      payload: { issue_id: 7 },
      project_id: "demo",
      rationale: "ready to run",
      requires_confirmation: true,
      risk_level: "medium",
      source: "pi_tool"
    } as const;

    expect(gatePiActionEnvelope(confirmEnvelope, { mode: "attended" })).toMatchObject({
      decision: "ask",
      reason: expect.stringContaining("confirmation")
    });
    expect(gatePiActionEnvelope({ ...confirmEnvelope, action_type: "issue.comment", requires_confirmation: false, risk_level: "low" }, {
      authorizedActions: [{ action_type: "issue.comment", issue_id: 7, project_id: "demo" }],
      mode: "delegated",
      scope: { project_id: "demo" }
    })).toMatchObject({ decision: "execute" });
    expect(gatePiActionEnvelope(confirmEnvelope, {
      authorizedActions: [{ action_type: "issue.enqueue", issue_id: 7, project_id: "demo" }],
      mode: "delegated",
      scope: { project_id: "demo" }
    })).toMatchObject({
      decision: "execute",
      reason: expect.stringContaining("authorization envelope")
    });
    expect(gatePiActionEnvelope({ ...confirmEnvelope, action_type: "issue.comment", requires_confirmation: false, risk_level: "low" }, {
      authorizedActions: [{ action_type: "issue.comment", issue_id: 8, project_id: "demo" }],
      mode: "delegated",
      scope: { project_id: "demo" }
    })).toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("delegated")
    });
  });

  test("MCP actions require capability allowlist when policy provides one", () => {
    const envelope = {
      action_type: "mcp.resource.read",
      payload: { capability_id: "docs:resource:runbook" },
      project_id: "demo",
      requires_confirmation: false,
      risk_level: "low",
      source: "pi_mcp_tool"
    } as const;

    expect(gatePiActionEnvelope(envelope, {
      allowedMcpCapabilities: ["docs:resource:runbook"],
      authorizedActions: [{ action_type: "mcp.resource.read", project_id: "demo" }],
      mode: "delegated",
      scope: { project_id: "demo" }
    })).toMatchObject({ decision: "execute" });
    expect(gatePiActionEnvelope(envelope, {
      allowedMcpCapabilities: ["docs:resource:other"],
      authorizedActions: [{ action_type: "mcp.resource.read", project_id: "demo" }],
      mode: "delegated",
      scope: { project_id: "demo" }
    })).toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("MCP")
    });
    expect(gatePiActionEnvelope(envelope, {
      allowedMcpCapabilities: ["docs:resource:other"],
      mode: "attended"
    })).toMatchObject({ decision: "deny" });
    expect(gatePiActionEnvelope(envelope, {
      allowedMcpCapabilities: undefined,
      mode: "attended"
    })).toMatchObject({ decision: "execute" });
  });

  test("MCP gate honors delegation allowlist aliases and keeps high-risk calls pending", () => {
    const envelope = {
      action_type: "mcp.tool.call",
      payload: { capability_id: "docs:tool:delete_doc", input: { id: "runbook" } },
      project_id: "demo",
      requires_confirmation: true,
      risk_level: "high",
      source: "pi_mcp_tool"
    } as const;

    expect(gatePiActionEnvelope(envelope, { mode: "attended" })).toMatchObject({
      decision: "ask",
      reason: expect.stringContaining("confirmation")
    });
    expect(gatePiActionEnvelope(envelope, {
      allowed_mcp_capabilities: ["docs:tool:delete_doc"],
      authorizedActions: [{ action_type: "mcp.tool.call", project_id: "demo" }],
      mode: "delegated",
      scope: { project_id: "demo" }
    })).toMatchObject({
      decision: "ask",
      reason: expect.stringContaining("confirmation")
    });
    expect(gatePiActionEnvelope(envelope, {
      allowed_mcp_capabilities: ["docs:tool:search"],
      authorizedActions: [{ action_type: "mcp.tool.call", project_id: "demo" }],
      mode: "delegated",
      scope: { project_id: "demo" }
    })).toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("MCP")
    });
  });

  test("delegated authorization does not bypass high-risk confirmation", () => {
    const envelope = {
      action_type: "session.steer",
      payload: { prompt: "change running executor", session_key: "codex:thread-1" },
      project_id: "demo",
      requires_confirmation: true,
      risk_level: "high",
      source: "pi_tool"
    } as const;

    expect(gatePiActionEnvelope(envelope, {
      authorizedActions: [{ action_type: "session.steer", project_id: "demo" }],
      mode: "delegated",
      scope: { project_id: "demo" }
    })).toMatchObject({
      decision: "ask",
      reason: expect.stringContaining("confirmation")
    });
  });

});
