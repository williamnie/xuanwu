import type { RunnerDatabase } from "../../db/database.ts";
import { getIssue } from "../../db/repositories/issues.ts";
import { getProject } from "../../db/repositories/projects.ts";
import { getPiDelegation } from "../../db/repositories/pi.ts";
import { gatePiActionEnvelope, type PiGatePolicy } from "../../pi/actionGate.ts";
import { JEV_CAPABILITY_ID, JEV_SKILL_ID, JEV_TOOL_NAME, jevCredentialStatus, jevPackage, readJevConfig, record, type JevScope, type JevSkillConfig } from "./config.ts";

export type JevContext = {
  authorization?: PiGatePolicy;
  conversationID?: string;
  delegationID?: string;
  heartbeatID?: string;
  issueID?: number;
  projectID?: string;
  source?: string;
};

export function jevScope(db: RunnerDatabase, context: JevContext): JevScope | "unknown" {
  if (context.issueID && getIssue(db, context.issueID)?.source_session_id.startsWith("github:")) return "github";
  if (context.source === "github") return "github";
  if (["feishu", "feishu_runner_chat", "feishu_runner_review"].includes(context.source ?? "")) return "feishu";
  if (["telegram", "telegram_runner_chat", "telegram_runner_review"].includes(context.source ?? "")) return "telegram";
  if (context.heartbeatID || context.delegationID || context.source?.startsWith("pi_")) return "background";
  return !context.source || ["runner_chat", "runner_review"].includes(context.source) ? "web" : "unknown";
}

export function jevAllowed(db: RunnerDatabase, context: JevContext, config: JevSkillConfig = readJevConfig(db).config): boolean {
  try {
    const scope = jevScope(db, context);
    if (!config.enabled || scope === "unknown" || !config.scopes.includes(scope)) return false;
    const issue = context.issueID ? getIssue(db, context.issueID) : null;
    if (context.issueID && !issue) return false;
    if (issue && context.projectID && context.projectID !== issue.project_id) return false;
    const projectID = context.projectID || issue?.project_id;
    const project = projectID ? getProject(db, projectID) : null;
    if (projectID && !project) return false;
    const projectPolicy = record(JSON.parse(project?.default_skill_policy || "{}"));
    const ceilings: unknown[] = [projectPolicy.allowed ?? projectPolicy.allowed_skill_intents,
      context.authorization?.allowedSkillIntents ?? context.authorization?.allowed_skill_intents];
    const managerCycle = context.source === "pi_manager_cycle" && context.delegationID === `pi-cycle:${projectID}`;
    if (context.delegationID && !managerCycle) {
      const delegation = getPiDelegation(db, context.delegationID);
      if (!delegation) return false;
      ceilings.push(JSON.parse(delegation.allowed_skill_intents_json || "[]"));
    }
    if (!ceilings.every(value => value === undefined || (Array.isArray(value) && value.includes(JEV_SKILL_ID)))) return false;
    const mcpPolicy = record(JSON.parse(project?.default_mcp_policy || "{}"));
    const mcpCeilings = [mcpPolicy.allowed ?? mcpPolicy.allowed_mcp_capabilities,
      context.authorization?.allowedMcpCapabilities ?? context.authorization?.allowed_mcp_capabilities];
    if (!mcpCeilings.every(value => value === undefined || (Array.isArray(value) && value.includes(JEV_CAPABILITY_ID)))) return false;
    const forbidden = context.authorization?.forbiddenActions ?? context.authorization?.forbidden_actions ?? [];
    if (forbidden.includes("mcp.tool.call") || forbidden.includes("assistant.tool.call")) return false;
    return gatePiActionEnvelope({ action_type: "skill.optional.call", source: context.source || "optional_skill",
      project_id: projectID, issue_id: context.issueID, delegation_id: context.delegationID, heartbeat_id: context.heartbeatID,
      payload: { skill_id: JEV_SKILL_ID, capability_id: JEV_CAPABILITY_ID }, risk_level: "low", risk_gate: "safe", requires_confirmation: false
    }, context.authorization).decision === "execute";
  } catch { return false; }
}

export function jevAvailableForContext(db: RunnerDatabase, context: JevContext): boolean {
  const state = readJevConfig(db);
  const pkg = jevPackage();
  return !state.diagnostic && pkg.installed && !pkg.diagnostic && jevAllowed(db, context, state.config) && jevCredentialStatus(db, state.config).configured;
}

export function withOptionalJevTool(db: RunnerDatabase, context: JevContext, tools: readonly string[]): string[] {
  return [...tools, ...(jevAvailableForContext(db, context) ? [JEV_TOOL_NAME] : [])];
}

/** 后台管理原先默认不授予 MCP。显式启用技能仅授予这一项，显式项目 allowlist 仍优先。 */
export function managerJevAuthorization(db: RunnerDatabase, projectID: string, authorization: PiGatePolicy): PiGatePolicy {
  try {
    const project = getProject(db, projectID);
    const policy = record(JSON.parse(project?.default_mcp_policy || "{}"));
    if (policy.allowed !== undefined || policy.allowed_mcp_capabilities !== undefined ||
      !jevAvailableForContext(db, { projectID, source: "pi_manager_cycle" })) return authorization;
    return { ...authorization, allowedMcpCapabilities: [...new Set([...(authorization.allowedMcpCapabilities ?? []), JEV_CAPABILITY_ID])] };
  } catch { return authorization; }
}
