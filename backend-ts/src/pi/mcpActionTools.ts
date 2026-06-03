import type { RunnerDatabase } from "../db/database.ts";
import {
  listMcpResources,
  publicMcpRegistry,
  readMcpCapability,
  readMcpResource,
  recommendMcpRequirements
} from "../mcp/registry.ts";
import { createPendingPiAction, executeSafePiAction, type PiActionContext, type PiActionRequest } from "./actionEngine.ts";

export type PiMcpActionLayer = {
  callMcpTool(input: McpToolCallInput): unknown;
  listMcpRegistry(input: McpRegistryListInput): unknown;
  listMcpResources(input: McpResourceListInput): unknown;
  readMcpCapability(input: McpCapabilityReadInput): unknown;
  readMcpResource(input: McpResourceReadInput): unknown;
  recommendMcpRequirements(input: McpRequirementRecommendInput): unknown;
};

type McpActionContext = PiActionContext & { projectID?: string };
type McpRegistryListInput = {};
type McpCapabilityReadInput = { capability_id: string };
type McpRequirementRecommendInput = { description?: string; project_id?: string; title?: string };
type McpResourceListInput = { server_id?: string };
type McpResourceReadInput = { capability_id: string };
type McpToolCallInput = { args?: Record<string, unknown>; capability_id: string; rationale?: string };

export function createPiMcpActions(db: RunnerDatabase, context: McpActionContext = {}): PiMcpActionLayer {
  const mcpContext = { ...context, source: context.source || "pi_mcp_tool" };
  return {
    callMcpTool: (input) => callMcpTool(db, mcpContext, input),
    listMcpRegistry: () => safeMcpRegistry(db, mcpContext),
    listMcpResources: (input) => safeMcpResources(db, mcpContext, input),
    readMcpCapability: (input) => safeMcpCapability(db, mcpContext, input),
    readMcpResource: (input) => safeMcpResource(db, mcpContext, input),
    recommendMcpRequirements: (input) => safeMcpRecommend(db, mcpContext, input)
  };
}

function safeMcpRegistry(db: RunnerDatabase, context: McpActionContext) {
  return executeSafePiAction(db, context, {
    actionType: "mcp.registry.list",
    payload: {},
    projectID: cleanString(context.projectID),
    execute: () => ({ items: publicMcpRegistry() })
  });
}

function safeMcpCapability(db: RunnerDatabase, context: McpActionContext, input: McpCapabilityReadInput) {
  const capabilityID = cleanString(input.capability_id);
  return executeSafePiAction(db, context, {
    actionType: "mcp.capability.read",
    payload: { capability_id: capabilityID },
    projectID: cleanString(context.projectID),
    execute: () => readMcpCapability(capabilityID) ?? { id: capabilityID, missing: true }
  });
}

function safeMcpRecommend(db: RunnerDatabase, context: McpActionContext, input: McpRequirementRecommendInput) {
  const projectID = cleanString(input.project_id) || cleanString(context.projectID);
  return executeSafePiAction(db, context, {
    actionType: "mcp.requirement.recommend",
    payload: cleanPayload({ project_id: projectID, title: input.title ?? "", description: input.description ?? "" }),
    projectID,
    execute: () => ({ items: recommendMcpRequirements(input) })
  });
}

function safeMcpResources(db: RunnerDatabase, context: McpActionContext, input: McpResourceListInput) {
  return executeSafePiAction(db, context, {
    actionType: "mcp.resource.list",
    payload: cleanPayload({ server_id: input.server_id ?? "" }),
    projectID: cleanString(context.projectID),
    execute: () => ({ items: listMcpResources(input.server_id) })
  });
}

function safeMcpResource(db: RunnerDatabase, context: McpActionContext, input: McpResourceReadInput) {
  const capabilityID = cleanString(input.capability_id);
  const capability = readMcpCapability(capabilityID);
  const request: PiActionRequest = {
    actionType: "mcp.resource.read",
    payload: { capability_id: capabilityID },
    projectID: cleanString(context.projectID),
    riskOverride: capability ? { requiresConfirmation: capability.requires_confirmation, riskLevel: capability.risk_level } : { requiresConfirmation: true, riskLevel: "high" }
  };
  if (!capability?.read_only) return createPendingPiAction(db, context, request);
  return executeSafePiAction(db, context, { ...request, execute: () => readMcpResource(capabilityID) });
}

function callMcpTool(db: RunnerDatabase, context: McpActionContext, input: McpToolCallInput) {
  const capabilityID = cleanString(input.capability_id);
  const capability = readMcpCapability(capabilityID);
  const payload = { args: sanitizeArgs(input.args), capability_id: capabilityID };
  return createPendingPiAction(db, context, {
    actionType: "mcp.tool.call",
    payload,
    projectID: cleanString(context.projectID),
    rationale: input.rationale ?? `MCP tool ${capabilityID}`,
    riskOverride: capability ? { requiresConfirmation: capability.requires_confirmation, riskLevel: capability.risk_level } : undefined
  });
}

function sanitizeArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanPayload(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => cleanString(value) !== ""));
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
