import { Value } from "@sinclair/typebox/value";
import { parseDomainID } from "../../xuanwu/coreDomainContracts.ts";
import { EVIDENCE_KINDS, isKnownEvidenceKind } from "./contracts.ts";
import {
  type VerificationContractValidation,
  VERIFICATION_POLICY_SCHEMA,
  type WorkflowVerificationPolicy,
  PROJECT_VERIFICATION_OVERRIDE_SCHEMA,
  type ProjectVerificationOverride,
  type EvidenceRequirementGroup,
  type EvidenceRequirement,
  type EvaluateVerificationPolicyInput,
  VERIFICATION_RISK_LEVELS
} from "./policyModel.ts";

export function validateWorkflowVerificationPolicy(input: unknown): VerificationContractValidation {
  if (!Value.Check(VERIFICATION_POLICY_SCHEMA, input)) {
    return {
      errors: [...Value.Errors(VERIFICATION_POLICY_SCHEMA, input)].map((error) =>
        `schema ${error.path || "/"}: ${error.message}`
      ),
      ok: false
    };
  }
  const policy = input as WorkflowVerificationPolicy;
  const errors: string[] = [];
  uniqueValues(policy.kind_rules.map((rule) => rule.kind), "kind rule", errors);
  uniqueValues(policy.risk_overrides.map((override) => override.risk), "risk override", errors);
  for (const rule of policy.kind_rules) {
    if (isKnownEvidenceKind(rule.kind)) errors.push(`known Evidence kind ${rule.kind} cannot be re-registered`);
    uniqueValues(rule.allowed_assertion_origins, `${rule.kind} assertion origin`, errors);
    uniqueValues(rule.allowed_source_kinds, `${rule.kind} source kind`, errors);
  }
  for (const override of policy.risk_overrides) {
    if (override.risk === "forbidden" && override.manual_override !== "deny") {
      errors.push("forbidden risk cannot allow manual verification override");
    }
  }
  errors.push(...validatePolicyRequirements(policy));
  return { errors, ok: errors.length === 0 };
}

export function validateProjectVerificationOverride(
  input: unknown,
  policy?: WorkflowVerificationPolicy
): VerificationContractValidation {
  if (!Value.Check(PROJECT_VERIFICATION_OVERRIDE_SCHEMA, input)) {
    return {
      errors: [...Value.Errors(PROJECT_VERIFICATION_OVERRIDE_SCHEMA, input)].map((error) =>
        `schema ${error.path || "/"}: ${error.message}`
      ),
      ok: false
    };
  }
  const override = input as ProjectVerificationOverride;
  const errors: string[] = [];
  uniqueValues(override.promote_optional_requirement_ids, "promoted optional requirement", errors);
  uniqueValues(override.disallow_skip_requirement_ids, "skip-disabled requirement", errors);
  if (policy) errors.push(...validateProjectOverrideAgainstPolicy(override, policy));
  else errors.push(...validateGroups(override.additional_required_groups, new Set(), new Set(), "project override"));
  return { errors, ok: errors.length === 0 };
}

function validatePolicyRequirements(policy: WorkflowVerificationPolicy): string[] {
  const errors: string[] = [];
  const groupIDs = new Set<string>();
  const requirementIDs = new Set<string>();
  errors.push(...validateGroups(policy.required_groups, groupIDs, requirementIDs, "policy"));
  errors.push(...validateRequirements(policy.optional_requirements, requirementIDs, "optional"));
  for (const requirement of policy.optional_requirements) {
    if (requirement.skip) errors.push(`optional requirement ${requirement.id} cannot define skip policy`);
  }
  for (const override of policy.risk_overrides) {
    errors.push(...validateGroups(
      override.additional_required_groups,
      groupIDs,
      requirementIDs,
      `risk override ${override.risk}`
    ));
  }
  const registeredKinds = new Set(policy.kind_rules.map((rule) => rule.kind));
  for (const requirement of allPolicyRequirements(policy)) {
    for (const kind of requirement.evidence_kinds) {
      if (!isKnownEvidenceKind(kind) && !registeredKinds.has(kind)) {
        errors.push(`${requirement.id} references unregistered Evidence kind ${kind}`);
      }
    }
  }
  return errors;
}

function validateGroups(
  groups: readonly EvidenceRequirementGroup[],
  groupIDs: Set<string>,
  requirementIDs: Set<string>,
  label: string
): string[] {
  const errors: string[] = [];
  for (const group of groups) {
    if (groupIDs.has(group.id)) errors.push(`duplicate ${label} group ${group.id}`);
    groupIDs.add(group.id);
    errors.push(...validateRequirements(group.requirements, requirementIDs, `group ${group.id}`));
  }
  return errors;
}

function validateRequirements(
  requirements: readonly EvidenceRequirement[],
  requirementIDs: Set<string>,
  label: string
): string[] {
  const errors: string[] = [];
  for (const requirement of requirements) {
    if (requirementIDs.has(requirement.id)) errors.push(`duplicate ${label} requirement ${requirement.id}`);
    requirementIDs.add(requirement.id);
    uniqueValues(requirement.evidence_kinds, `${requirement.id} Evidence kind`, errors);
    if (requirement.skip) uniqueValues(requirement.skip.allowed_reason_codes, `${requirement.id} skip reason`, errors);
    for (const assertion of requirement.fact_assertions) {
      const comparesValue = assertion.operator === "equals" || assertion.operator === "not_equals";
      if (comparesValue && !("expected" in assertion)) {
        errors.push(`${requirement.id} ${assertion.operator} assertion ${assertion.key} requires expected`);
      }
      if (!comparesValue && "expected" in assertion) {
        errors.push(`${requirement.id} ${assertion.operator} assertion ${assertion.key} cannot define expected`);
      }
    }
  }
  return errors;
}

function validateProjectOverrideAgainstPolicy(
  override: ProjectVerificationOverride,
  policy: WorkflowVerificationPolicy
): string[] {
  const errors: string[] = [];
  if (override.policy_id !== policy.id) errors.push("project override references another policy");
  if (override.base_policy_revision !== policy.revision) errors.push("project override base revision is stale");
  const optionalIDs = new Set(policy.optional_requirements.map((requirement) => requirement.id));
  for (const requirementID of override.promote_optional_requirement_ids) {
    if (!optionalIDs.has(requirementID)) errors.push(`project override cannot promote unknown optional requirement ${requirementID}`);
  }
  const baseRequirements = allPolicyRequirements(policy);
  const baseIDs = new Set(baseRequirements.map((requirement) => requirement.id));
  const skippableIDs = new Set(baseRequirements.filter((requirement) => requirement.skip).map((requirement) => requirement.id));
  for (const requirementID of override.disallow_skip_requirement_ids) {
    if (!baseIDs.has(requirementID)) errors.push(`project override references unknown requirement ${requirementID}`);
    else if (!skippableIDs.has(requirementID)) errors.push(`project override cannot disable absent skip policy for ${requirementID}`);
  }
  const existingGroupIDs = new Set(allPolicyGroups(policy).map((group) => group.id));
  const existingRequirementIDs = new Set(baseIDs);
  for (const requirementID of override.promote_optional_requirement_ids) {
    if (existingGroupIDs.has(`project.${requirementID}`)) {
      errors.push(`project override promoted group collides with project.${requirementID}`);
    }
  }
  errors.push(...validateGroups(override.additional_required_groups, existingGroupIDs, existingRequirementIDs, "project override"));
  const registeredKinds = new Set<string>([...EVIDENCE_KINDS, ...policy.kind_rules.map((rule) => rule.kind)]);
  for (const group of override.additional_required_groups) {
    for (const requirement of group.requirements) {
      for (const kind of requirement.evidence_kinds) {
        if (!registeredKinds.has(kind)) errors.push(`${requirement.id} references unregistered Evidence kind ${kind}`);
      }
    }
  }
  return errors;
}

export function validateEvaluationInput(input: EvaluateVerificationPolicyInput): string[] {
  const errors = [...validateWorkflowVerificationPolicy(input.policy).errors];
  const context = input.context;
  if (!context || parseDomainID(context.work_id)?.kind !== "work") errors.push("evaluation work_id is invalid");
  if (!context?.project_id?.trim()) errors.push("evaluation project_id is required");
  if (!VERIFICATION_RISK_LEVELS.includes(context?.risk)) errors.push("evaluation risk is invalid");
  if (!isIsoTimestamp(context?.now)) errors.push("evaluation now must be an ISO timestamp");
  if (context?.run_id && parseDomainID(context.run_id)?.kind !== "run") errors.push("evaluation run_id is invalid");
  if (context?.attempt_id && !context.run_id) errors.push("evaluation attempt_id requires run_id");
  if (context?.attempt_id && context.run_id && !context.attempt_id.startsWith(`${context.run_id}~attempt:`)) {
    errors.push("evaluation attempt_id must belong to run_id");
  }
  const evidenceIDs = input.evidence.map((evidence) => evidence.id);
  uniqueValues(evidenceIDs, "Evidence id", errors);
  const skipRequirementIDs = (input.skip_decisions ?? []).map((decision) => decision.requirement_id);
  uniqueValues(skipRequirementIDs, "skip decision requirement", errors);
  for (const [ref, available] of Object.entries(input.artifact_availability ?? {})) {
    if (!ref.trim() || typeof available !== "boolean") errors.push("artifact availability must map non-empty refs to booleans");
  }
  if (input.project_override) {
    const validation = validateProjectVerificationOverride(input.project_override, input.policy);
    errors.push(...validation.errors);
    if (input.project_override.project_id !== context?.project_id) errors.push("project override belongs to another project");
  }
  return errors;
}

function allPolicyGroups(policy: WorkflowVerificationPolicy): EvidenceRequirementGroup[] {
  return [
    ...policy.required_groups,
    ...policy.risk_overrides.flatMap((override) => override.additional_required_groups)
  ];
}

function allPolicyRequirements(policy: WorkflowVerificationPolicy): EvidenceRequirement[] {
  return [...allPolicyGroups(policy).flatMap((group) => group.requirements), ...policy.optional_requirements];
}

function uniqueValues(values: readonly string[], label: string, errors: string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) errors.push(`duplicate ${label} ${value}`);
    seen.add(value);
  }
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
