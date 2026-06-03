import type { Project } from "../db/repositories/projects.ts";
import { parseMcpPolicy } from "../mcp/policy.ts";
import type { PiGatePolicy } from "../pi/actionGate.ts";
import { parseSkillPolicy } from "../skills/intents.ts";

export function managerCycleAuthorization(project: Project): PiGatePolicy {
  const projectID = project.id;
  return {
    allowedMcpCapabilities: parseMcpPolicy(project.default_mcp_policy).allowed ?? [],
    allowedSkillIntents: parseSkillPolicy(project.default_skill_policy).allowed ?? [],
    authorizedActions: [
      { action_type: "agent.profile_recommend", project_id: projectID },
      { action_type: "issue.list", project_id: projectID }, { action_type: "issue.read", project_id: projectID },
      { action_type: "issue.state_diagnose", project_id: projectID }, { action_type: "project.list" },
      { action_type: "project.status", project_id: projectID }, { action_type: "session.list", project_id: projectID },
      { action_type: "session.read_summary", project_id: projectID }, { action_type: "memory.search", project_id: projectID },
      { action_type: "skill.list" }, { action_type: "skill.read" }, { action_type: "skill.recommend" },
      { action_type: "skill.intent_audit", project_id: projectID },
      { action_type: "sdk.read", project_id: projectID }, { action_type: "sdk.grep", project_id: projectID },
      { action_type: "sdk.find", project_id: projectID }, { action_type: "sdk.ls", project_id: projectID },
      { action_type: "mcp.registry.list", project_id: projectID },
      { action_type: "mcp.capability.read", project_id: projectID },
      { action_type: "mcp.requirement.recommend", project_id: projectID },
      { action_type: "mcp.resource.list", project_id: projectID },
      { action_type: "mcp.resource.read", project_id: projectID }
    ],
    mode: "delegated",
    scope: { project_id: projectID }
  };
}
