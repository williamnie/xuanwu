import type { RunnerDatabase } from "../db/database.ts";
import {
  isMcpServerAuthorized,
  type McpCapability,
  listMcpResources,
  publicMcpRegistry,
  readMcpCapability,
  readMcpResource,
  readMcpServer,
  recommendMcpRequirements
} from "../mcp/registry.ts";
import { executeSafePiAction, type PiActionContext, type PiActionRequest } from "./actionEngine.ts";

export type PiMcpActionLayer = {
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

export function createPiMcpActions(db: RunnerDatabase, context: McpActionContext = {}): PiMcpActionLayer {
  const mcpContext = { ...context, source: context.source || "pi_mcp_tool" };
  return {
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
    execute: () => publicMcpCapability(readMcpCapability(capabilityID)) ?? { id: capabilityID, missing: true }
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
  const serverID = cleanString(input.server_id);
  const server = serverID === "" ? null : readMcpServer(serverID);
  const request = {
    actionType: "mcp.resource.list",
    payload: cleanPayload({ server_id: serverID }),
    projectID: cleanString(context.projectID)
  };
  if (serverID !== "" && (!server || !isMcpServerAuthorized(server))) {
    return denyMcpAction(db, context, request);
  }
  return executeSafePiAction(db, context, {
    ...request,
    execute: () => ({ items: listMcpResources(serverID) })
  });
}

function safeMcpResource(db: RunnerDatabase, context: McpActionContext, input: McpResourceReadInput) {
  const capabilityID = cleanString(input.capability_id);
  const capability = readMcpCapability(capabilityID);
  const server = capability ? readMcpServer(capability.server_id) : null;
  const request: PiActionRequest = {
    actionType: "mcp.resource.read",
    payload: { capability_id: capabilityID },
    projectID: cleanString(context.projectID),
    riskOverride: capability ? { requiresConfirmation: capability.requires_confirmation, riskLevel: capability.risk_level } : { requiresConfirmation: true, riskLevel: "high" }
  };
  if (!capability || !server || !isMcpServerAuthorized(server)) return denyMcpAction(db, context, request);
  if (capability.permission !== "read") return denyMcpAction(db, context, request);
  return executeSafePiAction(db, context, { ...request, execute: () => readMcpResource(capabilityID) });
}

function denyMcpAction(db: RunnerDatabase, context: McpActionContext, request: PiActionRequest) {
  const forbidden = [request.actionType];
  return executeSafePiAction(db, {
    ...context,
    authorization: { ...context.authorization, forbiddenActions: forbidden, forbidden_actions: forbidden }
  }, {
    ...request,
    execute: () => ({ denied: true })
  });
}

function cleanPayload(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => cleanString(value) !== ""));
}

function publicMcpCapability(capability: McpCapability | null): Omit<McpCapability, "content"> | null {
  if (!capability) return null;
  const { content: _content, ...safe } = capability;
  return safe;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
