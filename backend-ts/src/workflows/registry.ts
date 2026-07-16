import type { SkillMetadata } from "../skills/registry.ts";
import type { SkillRegistryTool } from "../skills/runtimeManifest.ts";
import {
  validateWorkflowVerificationPolicy,
  type ProjectVerificationOverride,
  type WorkflowVerificationPolicy
} from "../domain/evidence/policy.ts";
import { TOOL_PERMISSIONS, type ToolPermission } from "../pi/toolProviderEnvelope.ts";
import {
  applyWorkflowProjectOverride,
  parseWorkflowManifestRef,
  validateWorkflowManifest,
  validateWorkflowProjectOverride,
  workflowManifestRef,
  type WorkflowManifest,
  type WorkflowProjectOverride,
  type WorkflowValidationIssue
} from "./manifest.ts";

export type WorkflowManifestRegistration = { manifest: unknown; source_path: string };
export type WorkflowProjectOverrideRegistration = { override: unknown; source_path: string };
export type WorkflowRegistrySkill = Pick<
  SkillMetadata,
  "id" | "name" | "permissions" | "required_tools"
>;
export type WorkflowRegistryOptions = {
  agent_profile_ids: readonly string[];
  available_actions: readonly string[];
  manifests: readonly WorkflowManifestRegistration[];
  project_overrides?: readonly WorkflowProjectOverrideRegistration[];
  skills: readonly WorkflowRegistrySkill[];
  tools: readonly SkillRegistryTool[];
  verification_policies: readonly WorkflowVerificationPolicy[];
};

export type WorkflowRegistryDiagnostic = {
  code:
    | "duplicate_manifest"
    | "duplicate_project_override"
    | "invalid_manifest"
    | "invalid_project_override"
    | "missing_action"
    | "missing_agent_profile"
    | "missing_skill"
    | "missing_tool"
    | "missing_verification_policy"
    | "permission_conflict"
    | "unknown_field"
    | "unsupported_version";
  message: string;
  path: string;
  project_id?: string;
  severity: "error";
  source_path: string;
  workflow_ref?: string;
};

export type WorkflowRegistryItem = {
  manifest: WorkflowManifest;
  ready: boolean;
  ref: string;
  source_path: string;
};

export type WorkflowResolution = {
  manifest: WorkflowManifest;
  manifest_ref: string;
  project_id?: string;
  project_override_applied: boolean;
  project_override_audit_ref?: string;
  source_path: string;
  verification_overrides: ProjectVerificationOverride[];
};

export type WorkflowResolutionResult =
  | { ok: true; resolution: WorkflowResolution }
  | { diagnostics: WorkflowRegistryDiagnostic[]; ok: false };

export type WorkflowRegistry = {
  diagnostics: WorkflowRegistryDiagnostic[];
  items: WorkflowRegistryItem[];
  resolve: (manifestRef: string, projectID?: string) => WorkflowResolutionResult;
};

type StoredOverride = { override: WorkflowProjectOverride; source_path: string };

export function createWorkflowRegistry(options: WorkflowRegistryOptions): WorkflowRegistry {
  const diagnostics: WorkflowRegistryDiagnostic[] = [];
  const entries = new Map<string, WorkflowRegistryItem>();
  const manifestConflicts = new Set<string>();

  for (const registration of options.manifests) {
    const validation = validateWorkflowManifest(registration.manifest);
    if (!validation.ok) {
      diagnostics.push(...validation.issues.map((issue) => validationDiagnostic(issue, registration.source_path)));
      continue;
    }
    const manifest = registration.manifest as WorkflowManifest;
    const ref = workflowManifestRef(manifest);
    if (entries.has(ref) || manifestConflicts.has(ref)) {
      entries.delete(ref);
      manifestConflicts.add(ref);
      diagnostics.push(diagnostic("duplicate_manifest", registration.source_path, "duplicate workflow manifest revision", "$", ref));
      continue;
    }
    const dependencyIssues = manifestDependencyDiagnostics(manifest, registration.source_path, options);
    diagnostics.push(...dependencyIssues);
    entries.set(ref, {
      manifest: structuredClone(manifest),
      ready: dependencyIssues.length === 0,
      ref,
      source_path: registration.source_path
    });
  }

  const overrides = new Map<string, StoredOverride>();
  const blockedOverrides = new Set<string>();
  for (const registration of options.project_overrides ?? []) {
    const target = overrideTarget(registration.override);
    const base = target ? entries.get(target.manifest_ref)?.manifest : undefined;
    const validation = validateWorkflowProjectOverride(
      registration.override,
      base,
      options.verification_policies
    );
    if (!validation.ok || !target || !base) {
      if (target) blockedOverrides.add(target.key);
      const issues = validation.issues.length > 0
        ? validation.issues
        : [{ code: "invalid_value", message: "project override references a missing workflow revision", path: "$" }] as WorkflowValidationIssue[];
      diagnostics.push(...issues.map((issue) => overrideValidationDiagnostic(issue, registration.source_path, target)));
      continue;
    }
    if (overrides.has(target.key) || blockedOverrides.has(target.key)) {
      overrides.delete(target.key);
      blockedOverrides.add(target.key);
      diagnostics.push(diagnostic(
        "duplicate_project_override",
        registration.source_path,
        "duplicate project override for workflow revision",
        "$",
        target.manifest_ref,
        target.project_id
      ));
      continue;
    }
    const effective = applyWorkflowProjectOverride(base, registration.override as WorkflowProjectOverride);
    const dependencyIssues = manifestDependencyDiagnostics(effective, registration.source_path, options, target.project_id);
    if (dependencyIssues.length > 0) {
      blockedOverrides.add(target.key);
      diagnostics.push(...dependencyIssues);
      continue;
    }
    overrides.set(target.key, {
      override: structuredClone(registration.override as WorkflowProjectOverride),
      source_path: registration.source_path
    });
  }

  const items = [...entries.values()].sort((left, right) => left.ref.localeCompare(right.ref));
  return {
    diagnostics,
    items,
    resolve: (manifestRef, projectID) => resolveWorkflow(
      manifestRef,
      projectID,
      entries,
      overrides,
      blockedOverrides,
      diagnostics
    )
  };
}

function resolveWorkflow(
  manifestRef: string,
  projectID: string | undefined,
  entries: ReadonlyMap<string, WorkflowRegistryItem>,
  overrides: ReadonlyMap<string, StoredOverride>,
  blockedOverrides: ReadonlySet<string>,
  diagnostics: readonly WorkflowRegistryDiagnostic[]
): WorkflowResolutionResult {
  const parsed = parseWorkflowManifestRef(manifestRef);
  if (!parsed) return resolutionFailure("invalid_manifest", "workflow ref is invalid", manifestRef, projectID);
  const ref = `${parsed.id}@${parsed.revision}`;
  const entry = entries.get(ref);
  if (!entry) return resolutionFailure("invalid_manifest", "workflow revision is not registered", ref, projectID);
  if (!entry.ready) {
    return {
      diagnostics: diagnostics.filter((item) => item.workflow_ref === ref && item.project_id === undefined),
      ok: false
    };
  }
  const cleanProjectID = projectID?.trim();
  if (!cleanProjectID) return { ok: true, resolution: baseResolution(entry) };
  const key = overrideKey(cleanProjectID, ref);
  if (blockedOverrides.has(key)) {
    const matching = diagnostics.filter((item) => item.workflow_ref === ref && item.project_id === cleanProjectID);
    return matching.length > 0
      ? { diagnostics: matching, ok: false }
      : resolutionFailure("invalid_project_override", "project override is invalid", ref, cleanProjectID);
  }
  const stored = overrides.get(key);
  if (!stored) return { ok: true, resolution: { ...baseResolution(entry), project_id: cleanProjectID } };
  return {
    ok: true,
    resolution: {
      manifest: applyWorkflowProjectOverride(entry.manifest, stored.override),
      manifest_ref: ref,
      project_id: cleanProjectID,
      project_override_applied: true,
      project_override_audit_ref: stored.override.audit_event_ref,
      source_path: entry.source_path,
      verification_overrides: structuredClone(stored.override.verification_overrides)
    }
  };
}

function baseResolution(entry: WorkflowRegistryItem): WorkflowResolution {
  return {
    manifest: structuredClone(entry.manifest),
    manifest_ref: entry.ref,
    project_override_applied: false,
    source_path: entry.source_path,
    verification_overrides: []
  };
}

function manifestDependencyDiagnostics(
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

function skillDependencyDiagnostics(
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

function validPolicyRefs(policies: readonly WorkflowVerificationPolicy[]): Set<string> {
  return new Set(policies.filter((policy) => validateWorkflowVerificationPolicy(policy).ok)
    .map((policy) => `${policy.id}@${policy.revision}`));
}

function overrideTarget(input: unknown): { key: string; manifest_ref: string; project_id: string } | null {
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

function overrideKey(projectID: string, manifestRef: string): string {
  return `${projectID}\u0000${manifestRef}`;
}

function validationDiagnostic(issue: WorkflowValidationIssue, sourcePath: string): WorkflowRegistryDiagnostic {
  const code = issue.code === "unknown_field" ? "unknown_field"
    : issue.code === "unsupported_version" ? "unsupported_version"
    : "invalid_manifest";
  return diagnostic(code, sourcePath, issue.message, issue.path);
}

function overrideValidationDiagnostic(
  issue: WorkflowValidationIssue,
  sourcePath: string,
  target: ReturnType<typeof overrideTarget>
): WorkflowRegistryDiagnostic {
  const code = issue.code === "unknown_field" ? "unknown_field"
    : issue.code === "unsupported_version" ? "unsupported_version"
    : "invalid_project_override";
  return diagnostic(code, sourcePath, issue.message, issue.path, target?.manifest_ref, target?.project_id);
}

function resolutionFailure(
  code: "invalid_manifest" | "invalid_project_override",
  message: string,
  ref: string,
  projectID?: string
): WorkflowResolutionResult {
  return { diagnostics: [diagnostic(code, "registry", message, "$", ref, projectID)], ok: false };
}

function diagnostic(
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

function toolMatches(tool: SkillRegistryTool, id: string): boolean {
  return tool.name === id || `${tool.provider_id ?? ""}:${tool.name}` === id || (tool.aliases ?? []).includes(id);
}

function isToolPermission(value: unknown): value is ToolPermission {
  return typeof value === "string" && (TOOL_PERMISSIONS as readonly string[]).includes(value);
}

function permissionRank(permission: ToolPermission): number {
  return TOOL_PERMISSIONS.indexOf(permission);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
