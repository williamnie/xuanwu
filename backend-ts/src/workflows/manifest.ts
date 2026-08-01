import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { EXECUTION_AGENT_ROLES } from "../agents/roles.ts";
import { DELIVERY_MODES } from "../domain/handoff/contracts.ts";
import {
  PROJECT_VERIFICATION_OVERRIDE_SCHEMA,
  validateProjectVerificationOverride,
  type ProjectVerificationOverride,
  type WorkflowVerificationPolicy
} from "../domain/evidence/policy.ts";
import { TOOL_PERMISSIONS, type ToolPermission } from "../pi/toolProviderEnvelope.ts";

export const WORKFLOW_MANIFEST_SCHEMA_VERSION = "xuanwu.workflow-manifest.v1" as const;
export const WORKFLOW_PROJECT_OVERRIDE_SCHEMA_VERSION = "xuanwu.workflow-project-override.v1" as const;
export const WORKFLOW_APPROVAL_MODES = ["none", "before_external_write", "before_stage"] as const;
export type WorkflowApprovalMode = typeof WORKFLOW_APPROVAL_MODES[number];

const identifier = Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9._-]*$" });
const registryID = Type.String({ minLength: 1, maxLength: 256, pattern: "^[a-z][a-z0-9._:-]*$" });
const reference = Type.String({ minLength: 1, maxLength: 8192 });
const workflowID = Type.String({ pattern: "^workflow:[a-z][a-z0-9._-]{0,127}$" });
const verificationPolicyRef = Type.String({
  pattern: "^verification-policy:[a-z][a-z0-9._-]{0,127}@[1-9][0-9]*$"
});
const actionOrToolID = Type.String({ minLength: 1, maxLength: 256, pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$" });
const toolPermission = Type.Union(TOOL_PERMISSIONS.map((permission) => Type.Literal(permission)));
const deliveryMode = Type.Union(DELIVERY_MODES.map((mode) => Type.Literal(mode)));
const approvalMode = Type.Union(WORKFLOW_APPROVAL_MODES.map((mode) => Type.Literal(mode)));

const agentSchema = Type.Object({
  role: Type.Union(EXECUTION_AGENT_ROLES.map((role) => Type.Literal(role))),
  profile_id: Type.Optional(identifier),
  required_skill_ids: Type.Array(registryID, { maxItems: 64 })
}, { additionalProperties: false });

const permissionSchema = Type.Object({
  max_tool_permission: toolPermission,
  allowed_tools: Type.Array(actionOrToolID, { maxItems: 256 }),
  allowed_actions: Type.Array(actionOrToolID, { maxItems: 256 })
}, { additionalProperties: false });

const retrySchema = Type.Object({
  max_attempts: Type.Integer({ minimum: 1, maximum: 10 }),
  backoff_seconds: Type.Array(Type.Integer({ minimum: 0, maximum: 24 * 60 * 60 }), { maxItems: 9 })
}, { additionalProperties: false });

const approvalSchema = Type.Object({
  mode: approvalMode,
  policy_ref: Type.Optional(reference)
}, { additionalProperties: false });

const handoffSchema = Type.Object({
  mode: deliveryMode,
  project_override_modes: Type.Array(deliveryMode, { minItems: 1, maxItems: DELIVERY_MODES.length })
}, { additionalProperties: false });

const stageSchema = Type.Object({
  id: identifier,
  name: Type.String({ minLength: 1, maxLength: 256 }),
  agent: agentSchema,
  permissions: permissionSchema,
  verification_policy_ref: verificationPolicyRef,
  retry: retrySchema,
  approval: approvalSchema,
  handoff: handoffSchema
}, { additionalProperties: false });

export const WORKFLOW_MANIFEST_SCHEMA = Type.Object({
  schema_version: Type.Literal(WORKFLOW_MANIFEST_SCHEMA_VERSION),
  id: workflowID,
  revision: Type.Integer({ minimum: 1 }),
  name: Type.String({ minLength: 1, maxLength: 256 }),
  description: Type.String({ minLength: 1, maxLength: 4096 }),
  stages: Type.Array(stageSchema, { minItems: 1, maxItems: 64 })
}, { additionalProperties: false });

const stageOverrideSchema = Type.Object({
  stage_id: identifier,
  agent_profile_id: Type.Optional(identifier),
  permissions: Type.Optional(permissionSchema),
  retry: Type.Optional(Type.Object({
    max_attempts: Type.Integer({ minimum: 1, maximum: 10 })
  }, { additionalProperties: false })),
  approval: Type.Optional(approvalSchema),
  handoff_mode: Type.Optional(deliveryMode)
}, { additionalProperties: false });

export const WORKFLOW_PROJECT_OVERRIDE_SCHEMA = Type.Object({
  schema_version: Type.Literal(WORKFLOW_PROJECT_OVERRIDE_SCHEMA_VERSION),
  project_id: Type.String({ minLength: 1, maxLength: 256 }),
  workflow_id: workflowID,
  base_revision: Type.Integer({ minimum: 1 }),
  stage_overrides: Type.Array(stageOverrideSchema, { maxItems: 64 }),
  verification_overrides: Type.Array(PROJECT_VERIFICATION_OVERRIDE_SCHEMA, { maxItems: 64 }),
  audit_event_ref: reference
}, { additionalProperties: false });

export type WorkflowManifest = Static<typeof WORKFLOW_MANIFEST_SCHEMA>;
export type WorkflowStage = WorkflowManifest["stages"][number];
export type WorkflowProjectOverride = Omit<
  Static<typeof WORKFLOW_PROJECT_OVERRIDE_SCHEMA>,
  "verification_overrides"
> & { verification_overrides: ProjectVerificationOverride[] };

export type WorkflowValidationIssue = {
  code: "invalid_value" | "unknown_field" | "unsupported_version";
  message: string;
  path: string;
};
export type WorkflowValidationResult = { issues: WorkflowValidationIssue[]; ok: boolean };
export type WorkflowManifestParseResult =
  | { manifest: WorkflowManifest; ok: true }
  | { issues: WorkflowValidationIssue[]; ok: false };

export function parseWorkflowManifestJSON(text: string): WorkflowManifestParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    return { issues: [{ code: "invalid_value", message: jsonError(error), path: "$" }], ok: false };
  }
  const result = validateWorkflowManifest(value);
  return result.ok
    ? { manifest: value as WorkflowManifest, ok: true }
    : { issues: result.issues, ok: false };
}

export function validateWorkflowManifest(input: unknown): WorkflowValidationResult {
  const issues = schemaIssues(WORKFLOW_MANIFEST_SCHEMA, input, WORKFLOW_MANIFEST_SCHEMA_VERSION);
  if (issues.length > 0) return { issues, ok: false };
  const manifest = input as WorkflowManifest;
  unique(manifest.stages.map((stage) => stage.id), "stages", issues);
  for (const [index, stage] of manifest.stages.entries()) validateStage(stage, index, issues);
  return { issues, ok: issues.length === 0 };
}

export function validateWorkflowProjectOverride(
  input: unknown,
  base?: WorkflowManifest,
  policies?: readonly WorkflowVerificationPolicy[]
): WorkflowValidationResult {
  const issues = schemaIssues(
    WORKFLOW_PROJECT_OVERRIDE_SCHEMA,
    input,
    WORKFLOW_PROJECT_OVERRIDE_SCHEMA_VERSION
  );
  if (issues.length > 0) return { issues, ok: false };
  const override = input as WorkflowProjectOverride;
  unique(override.stage_overrides.map((stage) => stage.stage_id), "stage_overrides", issues);
  unique(
    override.verification_overrides.map((item) => `${item.policy_id}@${item.base_policy_revision}`),
    "verification_overrides",
    issues
  );
  for (const verification of override.verification_overrides) {
    if (verification.project_id !== override.project_id) {
      add(issues, "verification_overrides", "verification override project_id must match project override");
    }
  }
  if (base) validateOverrideAgainstManifest(override, base, issues);
  if (base && policies) validateVerificationOverrides(override, base, policies, issues);
  return { issues, ok: issues.length === 0 };
}

export function workflowManifestRef(manifest: Pick<WorkflowManifest, "id" | "revision">): string {
  return `${manifest.id}@${manifest.revision}`;
}

export function parseWorkflowManifestRef(ref: string): { id: string; revision: number } | null {
  const match = /^(workflow:[a-z][a-z0-9._-]{0,127})@([1-9][0-9]*)$/.exec(ref.trim());
  if (!match) return null;
  const revision = Number(match[2]);
  return Number.isSafeInteger(revision) ? { id: match[1], revision } : null;
}

export function parseVerificationPolicyRef(ref: string): { id: string; revision: number } | null {
  const match = /^(verification-policy:[a-z][a-z0-9._-]{0,127})@([1-9][0-9]*)$/.exec(ref.trim());
  if (!match) return null;
  const revision = Number(match[2]);
  return Number.isSafeInteger(revision) ? { id: match[1], revision } : null;
}

export function applyWorkflowProjectOverride(
  manifest: WorkflowManifest,
  override: WorkflowProjectOverride
): WorkflowManifest {
  const validation = validateWorkflowProjectOverride(override, manifest);
  if (!validation.ok) throw new Error(validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
  const effective = structuredClone(manifest);
  const stages = new Map(effective.stages.map((stage) => [stage.id, stage]));
  for (const patch of override.stage_overrides) {
    const stage = stages.get(patch.stage_id)!;
    if (patch.agent_profile_id) stage.agent.profile_id = patch.agent_profile_id;
    if (patch.permissions) stage.permissions = structuredClone(patch.permissions);
    if (patch.retry) {
      stage.retry.max_attempts = patch.retry.max_attempts;
      stage.retry.backoff_seconds = stage.retry.backoff_seconds.slice(0, patch.retry.max_attempts - 1);
    }
    if (patch.approval) stage.approval = structuredClone(patch.approval);
    if (patch.handoff_mode) stage.handoff.mode = patch.handoff_mode;
  }
  return effective;
}

function validateStage(stage: WorkflowStage, index: number, issues: WorkflowValidationIssue[]): void {
  const path = `stages[${index}]`;
  unique(stage.agent.required_skill_ids, `${path}.agent.required_skill_ids`, issues);
  unique(stage.permissions.allowed_tools, `${path}.permissions.allowed_tools`, issues);
  unique(stage.permissions.allowed_actions, `${path}.permissions.allowed_actions`, issues);
  unique(stage.handoff.project_override_modes, `${path}.handoff.project_override_modes`, issues);
  if (stage.retry.backoff_seconds.length !== stage.retry.max_attempts - 1) {
    add(issues, `${path}.retry.backoff_seconds`, "must contain one delay for every retry after the first attempt");
  }
  if (stage.approval.mode === "none" && stage.approval.policy_ref !== undefined) {
    add(issues, `${path}.approval.policy_ref`, "must be omitted when approval mode is none");
  }
  if (stage.approval.mode !== "none" && !stage.approval.policy_ref?.trim()) {
    add(issues, `${path}.approval.policy_ref`, "is required when approval mode is not none");
  }
  if (stage.permissions.max_tool_permission === "dangerous" && stage.approval.mode === "none") {
    add(issues, `${path}.approval.mode`, "dangerous stages require an explicit approval mode");
  }
  if (!stage.handoff.project_override_modes.includes(stage.handoff.mode)) {
    add(issues, `${path}.handoff.project_override_modes`, "must include the default handoff mode");
  }
}

function validateOverrideAgainstManifest(
  override: WorkflowProjectOverride,
  base: WorkflowManifest,
  issues: WorkflowValidationIssue[]
): void {
  if (override.workflow_id !== base.id) add(issues, "workflow_id", "project override references another workflow");
  if (override.base_revision !== base.revision) add(issues, "base_revision", "project override base revision is stale");
  const stages = new Map(base.stages.map((stage) => [stage.id, stage]));
  for (const [index, patch] of override.stage_overrides.entries()) {
    const path = `stage_overrides[${index}]`;
    const stage = stages.get(patch.stage_id);
    if (!stage) {
      add(issues, `${path}.stage_id`, `references unknown stage ${patch.stage_id}`);
      continue;
    }
    if (patch.permissions) validatePermissionTightening(patch.permissions, stage.permissions, path, issues);
    if (patch.retry && patch.retry.max_attempts > stage.retry.max_attempts) {
      add(issues, `${path}.retry.max_attempts`, "project override cannot increase retry attempts");
    }
    if (patch.approval) validateApprovalTightening(patch.approval, stage.approval, path, issues);
    if (patch.handoff_mode && !stage.handoff.project_override_modes.includes(patch.handoff_mode)) {
      add(issues, `${path}.handoff_mode`, "is not allowed by the base workflow");
    }
  }
}

function validatePermissionTightening(
  override: WorkflowStage["permissions"],
  base: WorkflowStage["permissions"],
  path: string,
  issues: WorkflowValidationIssue[]
): void {
  if (permissionRank(override.max_tool_permission) > permissionRank(base.max_tool_permission)) {
    add(issues, `${path}.permissions.max_tool_permission`, "project override cannot increase tool permission");
  }
  subset(override.allowed_tools, base.allowed_tools, `${path}.permissions.allowed_tools`, issues);
  subset(override.allowed_actions, base.allowed_actions, `${path}.permissions.allowed_actions`, issues);
}

function validateApprovalTightening(
  override: WorkflowStage["approval"],
  base: WorkflowStage["approval"],
  path: string,
  issues: WorkflowValidationIssue[]
): void {
  if (approvalRank(override.mode) < approvalRank(base.mode)) {
    add(issues, `${path}.approval.mode`, "project override cannot weaken approval");
  }
  if (override.mode === base.mode && override.policy_ref !== base.policy_ref) {
    add(issues, `${path}.approval.policy_ref`, "cannot change policy without strengthening approval mode");
  }
}

function validateVerificationOverrides(
  override: WorkflowProjectOverride,
  base: WorkflowManifest,
  policies: readonly WorkflowVerificationPolicy[],
  issues: WorkflowValidationIssue[]
): void {
  const stageRefs = new Set(base.stages.map((stage) => stage.verification_policy_ref));
  for (const [index, projectOverride] of override.verification_overrides.entries()) {
    const ref = `${projectOverride.policy_id}@${projectOverride.base_policy_revision}`;
    if (!stageRefs.has(ref)) {
      add(issues, `verification_overrides[${index}]`, `references policy not used by workflow: ${ref}`);
      continue;
    }
    const policy = policies.find((item) => item.id === projectOverride.policy_id && item.revision === projectOverride.base_policy_revision);
    if (!policy) {
      add(issues, `verification_overrides[${index}]`, `references missing verification policy: ${ref}`);
      continue;
    }
    const validation = validateProjectVerificationOverride(projectOverride, policy);
    for (const message of validation.errors) add(issues, `verification_overrides[${index}]`, message);
  }
}

function schemaIssues(schema: TSchema, input: unknown, expectedVersion: string): WorkflowValidationIssue[] {
  return [...Value.Errors(schema, input)].map((error) => {
    const path = displayPath(error.path);
    if (path === "schema_version" && isRecord(input) && input.schema_version !== expectedVersion) {
      return { code: "unsupported_version", message: `must be ${expectedVersion}`, path };
    }
    return {
      code: error.message === "Unexpected property" ? "unknown_field" : "invalid_value",
      message: error.message,
      path
    };
  });
}

function displayPath(pointer: string): string {
  if (!pointer) return "$";
  return pointer.split("/").slice(1).map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((path, part) => /^\d+$/.test(part) ? `${path}[${part}]` : path ? `${path}.${part}` : part, "");
}

function unique(values: readonly string[], path: string, issues: WorkflowValidationIssue[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) add(issues, path, `contains duplicate value ${value}`);
    seen.add(value);
  }
}

function subset(
  values: readonly string[],
  allowed: readonly string[],
  path: string,
  issues: WorkflowValidationIssue[]
): void {
  const allowlist = new Set(allowed);
  for (const value of values) if (!allowlist.has(value)) add(issues, path, `cannot add ${value}`);
}

function permissionRank(permission: ToolPermission): number {
  return TOOL_PERMISSIONS.indexOf(permission);
}

function approvalRank(mode: WorkflowApprovalMode): number {
  return WORKFLOW_APPROVAL_MODES.indexOf(mode);
}

function add(issues: WorkflowValidationIssue[], path: string, message: string): void {
  issues.push({ code: "invalid_value", message, path });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonError(error: unknown): string {
  return error instanceof Error ? error.message : "invalid JSON";
}
