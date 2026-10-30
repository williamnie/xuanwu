import { type EvidenceID, type WorkID } from "../../xuanwu/coreDomainContracts.ts";
import { canSatisfyEvidenceGate, validateEvidence, type EvidenceRecord } from "./contracts.ts";
import {
  type WorkflowVerificationPolicy,
  type VerificationRiskLevel,
  type ProjectVerificationOverride,
  type EffectivePolicy,
  type EvidenceRequirement,
  type EvidenceIndex,
  type VerificationEvaluationContext,
  type VerificationKindRule,
  type VerificationSkipDecision,
  type VerificationRequirementResult,
  type EvidenceRequirementGroup,
  type VerificationGroupResult,
  type VerificationManualOverride,
  type VerificationOverrideResult,
  type VerificationRequirementStatus,
  type VerificationPolicyEvaluation
} from "./policyModel.ts";
import {
  matchesScope,
  matchesSelectorFacts,
  latestEvidenceFirst,
  canEvidenceSatisfyPolicy,
  factAssertionPasses
} from "./policyEvaluationEvidence.ts";

export function effectivePolicy(
  policy: WorkflowVerificationPolicy,
  risk: VerificationRiskLevel,
  projectOverride: ProjectVerificationOverride | undefined
): EffectivePolicy {
  const riskOverride = policy.risk_overrides.find((override) => override.risk === risk);
  let groups = [...policy.required_groups, ...(riskOverride?.additional_required_groups ?? [])];
  let optionalRequirements = [...policy.optional_requirements];
  let manualOverride = riskOverride?.manual_override ?? "deny";
  if (projectOverride) {
    const promoted = new Set(projectOverride.promote_optional_requirement_ids);
    const noSkip = new Set(projectOverride.disallow_skip_requirement_ids);
    groups = [
      ...groups.map((group) => ({
        ...group,
        requirements: group.requirements.map((requirement) => noSkip.has(requirement.id)
          ? withoutSkip(requirement)
          : requirement)
      })),
      ...projectOverride.additional_required_groups,
      ...optionalRequirements.filter((requirement) => promoted.has(requirement.id)).map((requirement) => ({
        id: `project.${requirement.id}`,
        operator: "all" as const,
        requirements: [withoutSkip(requirement)]
      }))
    ];
    optionalRequirements = optionalRequirements.filter((requirement) => !promoted.has(requirement.id));
    if (projectOverride.deny_manual_override) manualOverride = "deny";
  }
  return {
    groups,
    kindRules: new Map(policy.kind_rules.map((rule) => [rule.kind, rule])),
    manualOverride,
    optionalRequirements
  };
}

function withoutSkip(requirement: EvidenceRequirement): EvidenceRequirement {
  const { skip: _skip, ...required } = requirement;
  return required;
}

export function indexEvidence(evidence: readonly EvidenceRecord[], workID: WorkID): EvidenceIndex {
  const byID = new Map(evidence.map((record) => [record.id, record]));
  const superseded = new Set<EvidenceID>();
  for (const record of evidence) {
    const previous = record.supersedes_id ? byID.get(record.supersedes_id) : undefined;
    if (previous &&
      record.work_id === workID && previous.work_id === workID &&
      record.kind === previous.kind &&
      record.observed_at >= previous.observed_at && validateEvidence(record).ok) {
      superseded.add(previous.id);
    }
  }
  return { active: evidence.filter((record) => !superseded.has(record.id)) };
}

export function evaluateRequirement(input: {
  artifactAvailability: Readonly<Record<string, boolean>>;
  context: VerificationEvaluationContext;
  evidenceIndex: EvidenceIndex;
  kindRules: Map<string, VerificationKindRule>;
  requirement: EvidenceRequirement;
  skipDecision?: VerificationSkipDecision;
}): VerificationRequirementResult {
  const skip = evaluateSkip(input.requirement, input.skipDecision, input.context, input.evidenceIndex);
  if (skip) return skip;
  if (input.requirement.scope === "run" && !input.context.run_id) {
    return requirementResult(input.requirement.id, "missing", "current Run scope was not provided");
  }
  if (input.requirement.scope === "attempt" && !input.context.attempt_id) {
    return requirementResult(input.requirement.id, "missing", "current Attempt scope was not provided");
  }
  const candidates = input.evidenceIndex.active.filter((record) =>
    record.work_id === input.context.work_id &&
    input.requirement.evidence_kinds.includes(record.kind) &&
    matchesScope(record, input.requirement.scope, input.context) &&
    matchesSelectorFacts(record, input.requirement.selector_facts)
  ).sort(latestEvidenceFirst);
  const record = candidates[0];
  if (!record) return requirementResult(
    input.requirement.id,
    "missing",
    input.skipDecision ? "skip decision is not authorized and no matching Evidence" : "no matching Evidence"
  );
  const validation = validateEvidence(record);
  if (!validation.ok) {
    return requirementResult(input.requirement.id, "failed", `Evidence is invalid: ${validation.errors.join("; ")}`, record.id);
  }
  if (record.status === "pending") return requirementResult(input.requirement.id, "pending", "latest Evidence is pending", record.id);
  if (record.status !== "passed") {
    return requirementResult(input.requirement.id, "failed", `latest Evidence status is ${record.status}`, record.id);
  }
  if (!canEvidenceSatisfyPolicy(record, input.kindRules)) {
    return requirementResult(input.requirement.id, "failed", "Evidence provenance is not trusted by policy", record.id);
  }
  if (input.requirement.max_age_seconds !== undefined) {
    const age = Date.parse(input.context.now) - Date.parse(record.observed_at);
    if (age < 0) return requirementResult(input.requirement.id, "failed", "Evidence observation is in the future", record.id);
    if (age > input.requirement.max_age_seconds * 1000) {
      return requirementResult(input.requirement.id, "failed", "Evidence is stale", record.id);
    }
  }
  if (input.requirement.artifact_policy !== "ignore" && record.artifact_refs.length === 0) {
    return requirementResult(input.requirement.id, "failed", "required Evidence artifacts are missing", record.id);
  }
  if (input.requirement.artifact_policy === "available") {
    const unavailable = record.artifact_refs.find((artifact) => input.artifactAvailability[artifact.ref] !== true);
    if (unavailable) return requirementResult(input.requirement.id, "failed", `artifact is unavailable: ${unavailable.ref}`, record.id);
  }
  const failedAssertion = input.requirement.fact_assertions.find((assertion) =>
    !factAssertionPasses(assertion, record.decisive_output.facts)
  );
  if (failedAssertion) {
    return requirementResult(
      input.requirement.id,
      "failed",
      `Evidence fact assertion failed: ${failedAssertion.key} ${failedAssertion.operator}`,
      record.id
    );
  }
  return requirementResult(input.requirement.id, "passed", "latest matching Evidence satisfies policy", record.id);
}

function evaluateSkip(
  requirement: EvidenceRequirement,
  decision: VerificationSkipDecision | undefined,
  context: VerificationEvaluationContext,
  evidenceIndex: EvidenceIndex
): VerificationRequirementResult | null {
  if (!decision) return null;
  if (!requirement.skip) return null;
  if (!decision.reason.trim()) return null;
  if (!requirement.skip.allowed_reason_codes.includes(decision.reason_code)) return null;
  const evidence = evidenceIndex.active.find((record) => record.id === decision.human_evidence_id);
  if (!evidence || !trustedHumanDecision(evidence, context.work_id, decision.audit_event_ref)) return null;
  const facts = evidence.decisive_output.facts;
  if (facts.decision !== "skip" || facts.requirement_id !== requirement.id || facts.reason_code !== decision.reason_code) {
    return null;
  }
  return requirementResult(requirement.id, "skipped", `approved skip: ${decision.reason_code}`, evidence.id);
}

export function evaluateGroup(
  group: EvidenceRequirementGroup,
  evaluate: (requirement: EvidenceRequirement) => VerificationRequirementResult
): VerificationGroupResult {
  const requirements = group.requirements.map(evaluate);
  const satisfied = (result: VerificationRequirementResult) => result.status === "passed" || result.status === "skipped";
  let status: VerificationGroupResult["status"];
  if (group.operator === "all") {
    status = requirements.every(satisfied) ? "passed"
      : requirements.some((result) => result.status === "failed") ? "failed"
        : "pending";
  } else {
    status = requirements.some(satisfied) ? "passed"
      : requirements.every((result) => result.status === "failed") ? "failed"
        : "pending";
  }
  return { group_id: group.id, operator: group.operator, requirements, status };
}

export function groupDecision(groups: readonly VerificationGroupResult[]): "passed" | "pending" | "failed" {
  if (groups.every((group) => group.status === "passed")) return "passed";
  if (groups.some((group) => group.status === "failed")) return "failed";
  return "pending";
}

export function evaluateManualOverride(input: {
  context: VerificationEvaluationContext;
  evidenceIndex: EvidenceIndex;
  manualOverride?: VerificationManualOverride;
  mode: "deny" | "allow_with_human_evidence";
  policy: WorkflowVerificationPolicy;
  rawDecision: "passed" | "pending" | "failed";
}): VerificationOverrideResult {
  if (!input.manualOverride) return { applied: false, reasons: [] };
  const reasons: string[] = [];
  if (input.rawDecision === "passed") reasons.push("policy already passed without override");
  if (input.mode !== "allow_with_human_evidence") reasons.push("manual override is denied for this risk");
  if (!input.manualOverride.reason.trim()) reasons.push("manual override reason is required");
  const evidence = input.evidenceIndex.active.find((record) => record.id === input.manualOverride!.human_evidence_id);
  if (!evidence || !trustedHumanDecision(evidence, input.context.work_id, input.manualOverride.audit_event_ref)) {
    reasons.push("manual override lacks trusted human Evidence");
  } else {
    const facts = evidence.decisive_output.facts;
    if (facts.decision !== "verification_override") reasons.push("human Evidence decision is not verification_override");
    if (facts.policy_id !== input.policy.id) reasons.push("human Evidence references another policy");
    if (facts.policy_revision !== input.policy.revision) reasons.push("human Evidence references another policy revision");
    if (facts.risk !== input.context.risk) reasons.push("human Evidence references another risk");
  }
  return {
    applied: reasons.length === 0,
    ...(evidence ? { evidence_id: evidence.id } : {}),
    reasons
  };
}

function trustedHumanDecision(
  evidence: EvidenceRecord,
  workID: WorkID,
  auditEventRef: string
): boolean {
  return evidence.work_id === workID &&
    evidence.kind === "human" &&
    canSatisfyEvidenceGate(evidence) &&
    evidence.provenance.assertion_origin === "human_attestation" &&
    evidence.provenance.source_kind === "human_attestation" &&
    evidence.provenance.producer.kind === "user" &&
    evidence.provenance.audit_event_ref === auditEventRef;
}

function requirementResult(
  requirementID: string,
  status: VerificationRequirementStatus,
  reason: string,
  evidenceID?: EvidenceID
): VerificationRequirementResult {
  return { requirement_id: requirementID, status, reason, ...(evidenceID ? { evidence_id: evidenceID } : {}) };
}

export function invalidEvaluation(policyRef: string, errors: string[]): VerificationPolicyEvaluation {
  return {
    applied_project_override: false,
    applied_risk_override: false,
    decision: "invalid",
    errors,
    groups: [],
    optional_requirements: [],
    override: { applied: false, reasons: [] },
    policy_ref: policyRef,
    satisfied: false
  };
}
