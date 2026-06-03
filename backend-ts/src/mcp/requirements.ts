import type { Issue } from "../db/repositories/issues.ts";
import type { Project } from "../db/repositories/projects.ts";
import { parseMcpCapabilityList, parseMcpPolicy } from "./policy.ts";
import { readMcpCapability } from "./registry.ts";

export type McpRequirementDiagnostic = {
  capability_id: string;
  code: "mcp_capability_unregistered";
  message: string;
  scope: "issue.required" | "issue.recommended" | "project.allowed";
  severity: "warning";
};

export type McpRequirementSummary = {
  diagnostics: McpRequirementDiagnostic[];
  project_allowed: string[];
  recommended: string[];
  required: string[];
};

type RequirementIssue = Pick<Issue, "recommended_mcp_capabilities" | "required_mcp_capabilities">;
type RequirementProject = Pick<Project, "default_mcp_policy">;

export function issueMcpRequirementSummary(
  issue: RequirementIssue,
  project?: RequirementProject | null
): McpRequirementSummary {
  const required = parseMcpCapabilityList(issue.required_mcp_capabilities);
  const recommended = parseMcpCapabilityList(issue.recommended_mcp_capabilities);
  const projectAllowed = parseMcpPolicy(project?.default_mcp_policy).allowed ?? [];
  return {
    diagnostics: requirementDiagnostics(required, recommended, projectAllowed),
    project_allowed: projectAllowed,
    recommended,
    required
  };
}

function requirementDiagnostics(
  required: string[],
  recommended: string[],
  projectAllowed: string[]
): McpRequirementDiagnostic[] {
  const seen = new Set<string>();
  return [
    ...missingCapabilityDiagnostics(required, "issue.required", seen),
    ...missingCapabilityDiagnostics(recommended, "issue.recommended", seen),
    ...missingCapabilityDiagnostics(projectAllowed, "project.allowed", seen)
  ];
}

function missingCapabilityDiagnostics(
  ids: string[],
  scope: McpRequirementDiagnostic["scope"],
  seen: Set<string>
): McpRequirementDiagnostic[] {
  return ids.flatMap((id) => {
    const key = `${scope}:${id}`;
    if (seen.has(key) || readMcpCapability(id)) return [];
    seen.add(key);
    return [{
      capability_id: id,
      code: "mcp_capability_unregistered" as const,
      message: `MCP capability is not registered: ${id}`,
      scope,
      severity: "warning" as const
    }];
  });
}
