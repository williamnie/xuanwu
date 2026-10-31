import {
  type EvaluateVerificationPolicyInput,
  type VerificationPolicyEvaluation,
  type EvidenceRequirement
} from "./policyModel.ts";
import { validateEvaluationInput } from "./policyValidation.ts";
import {
  invalidEvaluation,
  effectivePolicy,
  indexEvidence,
  evaluateRequirement,
  evaluateGroup,
  groupDecision,
  evaluateManualOverride
} from "./policyEvaluation.ts";

export function evaluateWorkflowVerificationPolicy(
  input: EvaluateVerificationPolicyInput
): VerificationPolicyEvaluation {
  const policyRef = `${input.policy?.id ?? "verification-policy:invalid"}@${input.policy?.revision ?? 0}`;
  const errors = validateEvaluationInput(input);
  if (errors.length > 0) return invalidEvaluation(policyRef, errors);

  const effective = effectivePolicy(input.policy, input.context.risk, input.project_override);
  const evidenceIndex = indexEvidence(input.evidence, input.context.work_id);
  const skipDecisions = new Map((input.skip_decisions ?? []).map((decision) => [decision.requirement_id, decision]));
  const evaluate = (requirement: EvidenceRequirement) => evaluateRequirement({
    artifactAvailability: input.artifact_availability ?? {},
    context: input.context,
    evidenceIndex,
    kindRules: effective.kindRules,
    requirement,
    skipDecision: skipDecisions.get(requirement.id)
  });
  const groups = effective.groups.map((group) => evaluateGroup(group, evaluate));
  const optional = effective.optionalRequirements.map(evaluate);
  const rawDecision = groupDecision(groups);
  const override = evaluateManualOverride({
    context: input.context,
    evidenceIndex,
    manualOverride: input.manual_override,
    mode: effective.manualOverride,
    policy: input.policy,
    rawDecision
  });
  const overridden = rawDecision !== "passed" && override.applied;
  const decision = overridden ? "overridden" : rawDecision;
  return {
    applied_project_override: Boolean(input.project_override),
    applied_risk_override: input.policy.risk_overrides.some((override) => override.risk === input.context.risk),
    decision,
    errors: [],
    groups,
    optional_requirements: optional,
    override,
    policy_ref: policyRef,
    satisfied: decision === "passed" || decision === "overridden"
  };
}

export { VERIFICATION_POLICY_SCHEMA_VERSION } from "./policyModel.ts";
export { VERIFICATION_PROJECT_OVERRIDE_SCHEMA_VERSION } from "./policyModel.ts";
export type { VerificationRiskLevel } from "./policyModel.ts";
export { VERIFICATION_POLICY_SCHEMA } from "./policyModel.ts";
export { PROJECT_VERIFICATION_OVERRIDE_SCHEMA } from "./policyModel.ts";
export type { EvidenceRequirement } from "./policyModel.ts";
export type { WorkflowVerificationPolicy } from "./policyModel.ts";
export type { ProjectVerificationOverride } from "./policyModel.ts";
export type { VerificationRequirementStatus } from "./policyModel.ts";
export type { VerificationPolicyDecision } from "./policyModel.ts";
export { validateWorkflowVerificationPolicy } from "./policyValidation.ts";
export { validateProjectVerificationOverride } from "./policyValidation.ts";
