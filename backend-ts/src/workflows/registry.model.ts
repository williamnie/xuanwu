import type { SkillMetadata } from "../skills/registry.ts";
import type { SkillRegistryTool } from "../skills/runtimeManifest.ts";
import { type ProjectVerificationOverride, type WorkflowVerificationPolicy } from "../domain/evidence/policy.ts";
import { type WorkflowManifest, type WorkflowProjectOverride } from "./manifest.ts";

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

export type StoredOverride = { override: WorkflowProjectOverride; source_path: string };
