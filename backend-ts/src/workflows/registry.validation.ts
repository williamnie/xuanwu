import type { SkillRegistryTool } from "../skills/runtimeManifest.ts";
import { validateWorkflowVerificationPolicy, type WorkflowVerificationPolicy } from "../domain/evidence/policy.ts";
import { TOOL_PERMISSIONS, type ToolPermission } from "../pi/tools/toolProviderEnvelope.ts";
import { parseWorkflowManifestRef, workflowManifestRef, type WorkflowManifest, type WorkflowValidationIssue } from "./manifest.ts";
import { isRecord } from "../util/values.ts";
import type { WorkflowRegistryOptions, WorkflowRegistryDiagnostic, WorkflowRegistrySkill, WorkflowResolutionResult } from "./registry.model.ts";

export function manifestDependencyDiagnostics(
  manifest: WorkflowManifest,
  sourcePath: string,
  options: WorkflowRegistryOptions,
  projectID?: string
): WorkflowRegistryDiagnostic[] {
  const ref = workflowManifestRef(manifest);
  const diagnostics: WorkflowRegistryDiagnostic[] = [];
  const skills = new Map(options.skills.map((skill) => [skill.id, skill]));
  const profileIDs = new Set(options.agent_profile_ids);
  const actions = new Set(options.available_actions);
  const policyRefs = validPolicyRefs(options.verification_policies);

  manifest.stages.forEach((stage, index) => {
    const path = `stages[${index}]`;
    if (stage.agent.profile_id && !profileIDs.has(stage.agent.profile_id)) {
      diagnostics.push(diagnostic("missing_agent_profile", sourcePath, `agent profile missing: ${stage.agent.profile_id}`, `${path}.agent.profile_id`, ref, projectID));
    }
    for (const skillID of stage.agent.required_skill_ids) {
      const skill = skills.get(skillID);
      if (!skill) {
        diagnostics.push(diagnostic("missing_skill", sourcePath, `required skill missing: ${skillID}`, `${path}.agent.required_skill_ids`, ref, projectID));
        continue;
      }
      if (skill) diagnostics.push(...skillDependencyDiagnostics(stage, skill, sourcePath, path, ref, projectID, options.tools));
    }
    for (const toolID of stage.permissions.allowed_tools) {
      const tool = options.tools.find((candidate) => toolMatches(candidate, toolID));
      if (!tool) {
        diagnostics.push(diagnostic("missing_tool", sourcePath, `allowed tool missing: ${toolID}`, `${path}.permissions.allowed_tools`, ref, projectID));
      } else if (tool?.permission && permissionRank(tool.permission) > permissionRank(stage.permissions.max_tool_permission)) {
        diagnostics.push(diagnostic("permission_conflict", sourcePath, `tool ${toolID} requires ${tool.permission}`, `${path}.permissions.max_tool_permission`, ref, projectID));
      }
    }
    for (const action of stage.permissions.allowed_actions) {
      if (!actions.has(action)) diagnostics.push(diagnostic("missing_action", sourcePath, `allowed action missing: ${action}`, `${path}.permissions.allowed_actions`, ref, projectID));
    }
    if (!policyRefs.has(stage.verification_policy_ref)) {
      diagnostics.push(diagnostic("missing_verification_policy", sourcePath, `verification policy missing or invalid: ${stage.verification_policy_ref}`, `${path}.verification_policy_ref`, ref, projectID));
    }
  });
  return diagnostics;
}

export function skillDependencyDiagnostics(
  stage: WorkflowManifest["stages"][number],
  skill: WorkflowRegistrySkill,
  sourcePath: string,
  path: string,
  ref: string,
  projectID: string | undefined,
  tools: readonly SkillRegistryTool[]
): WorkflowRegistryDiagnostic[] {
  const diagnostics: WorkflowRegistryDiagnostic[] = [];
  const skillMax = skill.permissions?.max_tool_permission;
  if (isToolPermission(skillMax) && permissionRank(skillMax) > permissionRank(stage.permissions.max_tool_permission)) {
    diagnostics.push(diagnostic("permission_conflict", sourcePath, `skill ${skill.id} requires ${skillMax}`, `${path}.permissions.max_tool_permission`, ref, projectID));
  }
  for (const requiredTool of skill.required_tools) {
    if (!stage.permissions.allowed_tools.includes(requiredTool)) {
      diagnostics.push(diagnostic("permission_conflict", sourcePath, `skill ${skill.id} requires tool outside stage allowlist: ${requiredTool}`, `${path}.permissions.allowed_tools`, ref, projectID));
    } else if (!tools.some((tool) => toolMatches(tool, requiredTool))) {
      diagnostics.push(diagnostic("missing_tool", sourcePath, `skill ${skill.id} tool missing: ${requiredTool}`, `${path}.permissions.allowed_tools`, ref, projectID));
    }
  }
  return diagnostics;
}

export function validPolicyRefs(policies: readonly WorkflowVerificationPolicy[]): Set<string> {
  return new Set(policies.filter((policy) => validateWorkflowVerificationPolicy(policy).ok)
    .map((policy) => `${policy.id}@${policy.revision}`));
}

export function overrideTarget(input: unknown): { key: string; manifest_ref: string; project_id: string } | null {
  if (!isRecord(input) || typeof input.project_id !== "string" || typeof input.workflow_id !== "string" ||
    !Number.isSafeInteger(input.base_revision) || Number(input.base_revision) < 1) return null;
  const manifestRef = `${input.workflow_id}@${input.base_revision}`;
  if (!parseWorkflowManifestRef(manifestRef) || input.project_id.trim() === "") return null;
  return {
    key: overrideKey(input.project_id.trim(), manifestRef),
    manifest_ref: manifestRef,
    project_id: input.project_id.trim()
  };
}

export function overrideKey(projectID: string, manifestRef: string): string {
  return `${projectID}\u0000${manifestRef}`;
}

export function validationDiagnostic(issue: WorkflowValidationIssue, sourcePath: string): WorkflowRegistryDiagnostic {
  const code = issue.code === "unknown_field" ? "unknown_field"
    : issue.code === "unsupported_version" ? "unsupported_version"
    : "invalid_manifest";
  return diagnostic(code, sourcePath, issue.message, issue.path);
}

export function overrideValidationDiagnostic(
  issue: WorkflowValidationIssue,
  sourcePath: string,
  target: ReturnType<typeof overrideTarget>
): WorkflowRegistryDiagnostic {
  const code = issue.code === "unknown_field" ? "unknown_field"
    : issue.code === "unsupported_version" ? "unsupported_version"
    : "invalid_project_override";
  return diagnostic(code, sourcePath, issue.message, issue.path, target?.manifest_ref, target?.project_id);
}

export function resolutionFailure(
  code: "invalid_manifest" | "invalid_project_override",
  message: string,
  ref: string,
  projectID?: string
): WorkflowResolutionResult {
  return { diagnostics: [diagnostic(code, "registry", message, "$", ref, projectID)], ok: false };
}

export function diagnostic(
  code: WorkflowRegistryDiagnostic["code"],
  source_path: string,
  message: string,
  path: string,
  workflow_ref?: string,
  project_id?: string
): WorkflowRegistryDiagnostic {
  return {
    code,
    message,
    path,
    ...(project_id ? { project_id } : {}),
    severity: "error",
    source_path,
    ...(workflow_ref ? { workflow_ref } : {})
  };
}

export function toolMatches(tool: SkillRegistryTool, id: string): boolean {
  return tool.name === id || `${tool.provider_id ?? ""}:${tool.name}` === id || (tool.aliases ?? []).includes(id);
}

export function isToolPermission(value: unknown): value is ToolPermission {
  return typeof value === "string" && (TOOL_PERMISSIONS as readonly string[]).includes(value);
}

export function permissionRank(permission: ToolPermission): number {
  return TOOL_PERMISSIONS.indexOf(permission);
}
