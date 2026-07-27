import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../db/database.ts";
import { getActivePiMcpApprovalGrant } from "../db/repositories/pi.ts";
import type { McpCapability, McpRiskLevel, McpServerRegistry } from "./registry.ts";

export type McpInvocationApproval = {
  approvalMode: McpServerRegistry["approval_mode"];
  capabilityFingerprint: string;
  grantID: string;
  preconditionFailure: string;
  requiresConfirmation: boolean;
  riskLevel: McpRiskLevel;
};

export function resolveMcpInvocationApproval(input: {
  capability: McpCapability;
  db: RunnerDatabase;
  projectID?: string;
  server: McpServerRegistry;
}): McpInvocationApproval {
  const fingerprint = mcpCapabilityFingerprint(input.server, input.capability);
  const grant = input.projectID
    ? getActivePiMcpApprovalGrant(input.db, input.projectID, input.capability.id)
    : null;
  const validGrant = grant?.capability_fingerprint === fingerprint ? grant : null;
  const mode = input.server.approval_mode;
  const write = input.capability.permission !== "read" || !input.capability.read_only;
  if (mode === "read_only" && write) {
    return {
      approvalMode: mode,
      capabilityFingerprint: fingerprint,
      grantID: "",
      preconditionFailure: "MCP server is enabled in read-only mode",
      requiresConfirmation: false,
      riskLevel: input.capability.risk_level
    };
  }
  const intrinsicallyDangerous = input.capability.risk_level === "high" ||
    input.capability.permission === "admin" || input.capability.requires_confirmation;
  const requiresConfirmation = validGrant ? false : mode === "every_write" ? write : intrinsicallyDangerous;
  return {
    approvalMode: mode,
    capabilityFingerprint: fingerprint,
    grantID: validGrant?.id ?? "",
    preconditionFailure: "",
    requiresConfirmation,
    // actionGate intentionally treats every high-risk envelope as JIT approval,
    // independent of requires_confirmation. An exact persistent grant lowers
    // only this invocation's effective gate risk; the capability's stored risk
    // and audit payload remain unchanged.
    riskLevel: requiresConfirmation ? "high" : validGrant && intrinsicallyDangerous ? "medium" : input.capability.risk_level
  };
}

export function mcpCapabilityFingerprint(server: McpServerRegistry, capability: McpCapability): string {
  const material = stableJSON({
    approval_contract: 1,
    capability: {
      id: capability.id,
      input_schema: capability.input_schema ?? {},
      metadata: capability.metadata,
      permission: capability.permission,
      read_only: capability.read_only,
      requires_confirmation: capability.requires_confirmation,
      risk_level: capability.risk_level
    },
    server: {
      id: server.id,
      transport: server.transport ?? null,
      version: server.version ?? ""
    }
  });
  return createHash("sha256").update(material).digest("hex");
}

function stableJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJSON(child)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
