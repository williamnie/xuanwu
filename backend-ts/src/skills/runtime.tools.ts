import type { RunnerDatabase } from "../db/database.ts";
import { getProject } from "../db/repositories/projects.ts";
import { invokeReadOnlyAssistantTool } from "../pi/tools/readOnlyToolInvocation.ts";
import { createPiMcpActions } from "../pi/mcp/mcpActionTools.ts";
import { executeSafePiAction } from "../pi/actions/actionEngine.ts";
import { createPiProjectTools } from "../http/pi/piProjectTools.ts";
import { recordToolCallAuditEvent, type ToolCallAuditContext } from "../pi/actions/toolCallAudit.ts";
import { type AssistantToolRegistrySnapshot } from "../pi/tools/toolRegistrySnapshot.ts";
import type { AssistantTool } from "../pi/tools/toolProviderEnvelope.ts";
import type { SkillMetadata } from "./registry.ts";
import { cleanString } from "../util/values.ts";
import { SkillRuntimeError } from "./runtime.model.ts";
import type { ExecuteSkillRuntimeInput, JsonObject, SkillRuntimeWorkflowContext } from "./runtime.model.ts";
import { safeID, recordValue } from "./runtime.values.ts";
import { effectiveMaxPermission, permissionRank, skillMaxPermission } from "./runtime.permissions.ts";

export async function invokeGrantedTool(
  input: ExecuteSkillRuntimeInput,
  snapshot: AssistantToolRegistrySnapshot,
  audit: ToolCallAuditContext,
  grant: string,
  params: JsonObject,
  isActive: () => boolean
): Promise<unknown> {
  const invocationID = `skill:${safeID(input.runID)}:${crypto.randomUUID()}`;
  if (!isActive()) throw new SkillRuntimeError("skill_run_closed", "skill run is no longer active");
  const tool = resolveGrantedTool(input.skill.required_tools, snapshot.tools, grant);
  if (!tool) return denyTool(input.db, audit, invocationID, grant, params, "tool_not_granted", `tool is outside skill grants: ${grant}`);
  const max = effectiveMaxPermission(input.skill, input.workflow);
  if (permissionRank(tool.permission) > permissionRank(max)) {
    return denyTool(input.db, audit, invocationID, grant, params, "permission_denied", `tool ${grant} exceeds ${max} permission`);
  }
  if (tool.permission !== "read") {
    return await invokeGovernedSkillTool(input, snapshot, audit, tool, params, invocationID);
  }
  const result = await invokeReadOnlyAssistantTool({
    auditContext: audit,
    db: input.db,
    env: input.env,
    input: params,
    invocationID,
    manifestDirs: input.cliConnectorDirs,
    projectID: audit.projectID,
    providerID: tool.provider_id,
    timeoutMs: tool.timeout_ms,
    toolName: tool.name
  });
  if (result.status !== "succeeded") {
    throw new SkillRuntimeError(result.error?.code || `tool_${result.status}`, result.error?.message || `tool ${grant} ${result.status}`);
  }
  return result.output;
}

export async function invokeGovernedSkillTool(
  input: ExecuteSkillRuntimeInput,
  snapshot: AssistantToolRegistrySnapshot,
  audit: ToolCallAuditContext,
  tool: AssistantTool,
  params: JsonObject,
  invocationID: string
): Promise<unknown> {
  const provider = snapshot.providers.find((item) => item.id === tool.provider_id);
  const context = {
    bus: input.bus,
    conversationID: audit.conversationID,
    delegationID: audit.delegationID,
    heartbeatID: audit.heartbeatID,
    issueID: audit.issueID,
    projectID: audit.projectID,
    source: `skill_runtime:${input.skill.id}`
  };
  if (provider?.kind === "builtin") {
    const project = audit.projectID ? getProject(input.db, audit.projectID) ?? undefined : undefined;
    const definition = createPiProjectTools(input.db, project, context).find((item) => item.name === tool.name);
    if (!definition) {
      return denyTool(input.db, audit, invocationID, tool.name, params, "handler_not_allowed", `builtin tool is not governed: ${tool.name}`);
    }
    const result = await definition.execute(invocationID, params, undefined, undefined, {} as never);
    return recordValue(result).details ?? result;
  }
  if (provider?.kind === "mcp") {
    const capabilityID = cleanString(tool.metadata?.capability_id);
    if (capabilityID === "") {
      return denyTool(input.db, audit, invocationID, tool.name, params, "tool_not_granted", "MCP capability id is missing");
    }
    return await createPiMcpActions(input.db, context).callMcpTool({ capability_id: capabilityID, input: params });
  }
  return await executeSafePiAction(input.db, context, {
    actionType: "assistant.tool.call",
    payload: {
      input: params,
      manifest_dirs: input.cliConnectorDirs ?? [],
      permission: tool.permission,
      provider_id: tool.provider_id,
      tool_name: tool.name
    },
    issueID: audit.issueID,
    projectID: audit.projectID,
    riskOverride: { requiresConfirmation: true, riskLevel: "high" },
    execute: () => invokeReadOnlyAssistantTool({
      auditContext: audit,
      db: input.db,
      env: input.env,
      input: params,
      invocationID,
      manifestDirs: input.cliConnectorDirs,
      maxPermission: tool.permission,
      projectID: audit.projectID,
      providerID: tool.provider_id,
      toolName: tool.name
    })
  });
}

export function denyTool(
  db: RunnerDatabase,
  audit: ToolCallAuditContext,
  invocationID: string,
  grant: string,
  params: JsonObject,
  code: string,
  message: string
): never {
  recordToolCallAuditEvent(db, audit, {
    args: params,
    durationMs: 0,
    error: { message, type: code },
    providerID: "skill-runtime",
    status: "denied",
    toolCallID: invocationID,
    toolName: grant
  });
  throw new SkillRuntimeError(code, message);
}

export function validateWorkflowBoundary(skill: SkillMetadata, workflow: SkillRuntimeWorkflowContext | undefined): void {
  if (!workflow) return;
  if (!workflow.stage.agent.required_skill_ids.includes(skill.id)) {
    throw new SkillRuntimeError("workflow_skill_denied", `workflow stage does not require skill ${skill.id}`);
  }
  if (permissionRank(skillMaxPermission(skill)) > permissionRank(workflow.stage.permissions.max_tool_permission)) {
    throw new SkillRuntimeError("workflow_permission_denied", `skill permission exceeds workflow stage ceiling`);
  }
  for (const grant of skill.required_tools) {
    if (!workflow.stage.permissions.allowed_tools.includes(grant)) {
      throw new SkillRuntimeError("workflow_tool_denied", `skill tool is outside workflow stage allowlist: ${grant}`);
    }
  }
}

export function validateToolGrants(
  skill: SkillMetadata,
  snapshot: AssistantToolRegistrySnapshot,
  workflow: SkillRuntimeWorkflowContext | undefined
): void {
  const max = effectiveMaxPermission(skill, workflow);
  for (const grant of skill.required_tools) {
    const tool = resolveTool(snapshot.tools, grant);
    if (!tool) throw new SkillRuntimeError("required_tool_missing", `required tool missing: ${grant}`);
    if (permissionRank(tool.permission) > permissionRank(max)) {
      throw new SkillRuntimeError("permission_conflict", `required tool ${grant} exceeds ${max} permission`);
    }
  }
}

export function resolveGrantedTool(grants: string[], tools: AssistantTool[], requested: string): AssistantTool | undefined {
  const requestedTool = resolveTool(tools, requested);
  if (!requestedTool) return undefined;
  const granted = grants.some((grant) => toolMatches(requestedTool, grant));
  return granted ? requestedTool : undefined;
}

export function resolveTool(tools: AssistantTool[], id: string): AssistantTool | undefined {
  const matches = tools.filter((tool) => toolMatches(tool, id));
  return matches.length === 1 ? matches[0] : undefined;
}

export function toolMatches(tool: AssistantTool, id: string): boolean {
  const aliases = [cleanString(tool.metadata?.capability_id)].filter(Boolean);
  return tool.name === id || `${tool.provider_id}:${tool.name}` === id || aliases.includes(id);
}
