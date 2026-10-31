import type { ToolPermission } from "../pi/tools/toolProviderEnvelope.ts";
import type { SkillMetadata } from "./registry.ts";
import type { SkillRuntimeWorkflowContext } from "./runtime.model.ts";

export const TOOL_PERMISSIONS: ToolPermission[] = ["read", "write", "dangerous"];

export function effectiveMaxPermission(skill: SkillMetadata, workflow: SkillRuntimeWorkflowContext | undefined): ToolPermission {
  const skillMax = skillMaxPermission(skill);
  if (!workflow) return skillMax;
  return permissionRank(workflow.stage.permissions.max_tool_permission) < permissionRank(skillMax)
    ? workflow.stage.permissions.max_tool_permission
    : skillMax;
}

export function skillMaxPermission(skill: SkillMetadata): ToolPermission {
  const value = skill.permissions?.max_tool_permission;
  return typeof value === "string" && TOOL_PERMISSIONS.includes(value as ToolPermission)
    ? value as ToolPermission
    : "read";
}

export function permissionRank(permission: ToolPermission): number {
  return TOOL_PERMISSIONS.indexOf(permission);
}
