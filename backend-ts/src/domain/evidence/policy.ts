import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { parseDomainID, type EvidenceID, type RunID, type WorkID } from "../../xuanwu/coreDomainContracts.ts";
import {
  EVIDENCE_KINDS,
  canSatisfyEvidenceGate,
  isKnownEvidenceKind,
  validateEvidence,
  type EvidenceKind,
  type EvidenceRecord,
  type RunAttemptID
} from "./contracts.ts";

export const VERIFICATION_POLICY_SCHEMA_VERSION = 1 as const;
export const VERIFICATION_PROJECT_OVERRIDE_SCHEMA_VERSION = 1 as const;
export const VERIFICATION_RISK_LEVELS = ["safe", "confirm", "high", "forbidden"] as const;
export type VerificationRiskLevel = typeof VERIFICATION_RISK_LEVELS[number];

const id = Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9._-]*$" });
const requiredText = Type.String({ minLength: 1, maxLength: 4096 });
const policyID = Type.String({ pattern: "^verification-policy:[a-z][a-z0-9._-]{0,127}$" });
const evidenceKind = Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_.-]*$" });
const scalar = Type.Union([Type.String({ maxLength: 8192 }), Type.Number(), Type.Boolean(), Type.Null()]);
const factKey = Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9_.-]*$" });

const factAssertionSchema = Type.Object({
  key: factKey,
  operator: Type.Union([
    Type.Literal("equals"),
    Type.Literal("not_equals"),
    Type.Literal("truthy"),
    Type.Literal("falsy")
  ]),
  expected: Type.Optional(scalar)
}, { additionalProperties: false });

const skipPolicySchema = Type.Object({
  allowed_reason_codes: Type.Array(id, { minItems: 1, maxItems: 32 }),
  requires_human_evidence: Type.Literal(true)
}, { additionalProperties: false });

const evidenceRequirementSchema = Type.Object({
  id,
  evidence_kinds: Type.Array(evidenceKind, { minItems: 1, maxItems: 16 }),
  scope: Type.Union([Type.Literal("work"), Type.Literal("run"), Type.Literal("attempt")]),
  selector_facts: Type.Optional(Type.Record(factKey, scalar)),
  fact_assertions: Type.Array(factAssertionSchema, { maxItems: 32 }),
  max_age_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 * 24 * 60 * 60 })),
  artifact_policy: Type.Union([
    Type.Literal("ignore"),
    Type.Literal("present"),
    Type.Literal("available")
  ]),
  skip: Type.Optional(skipPolicySchema)
}, { additionalProperties: false });

const evidenceGroupSchema = Type.Object({
  id,
  operator: Type.Union([Type.Literal("all"), Type.Literal("any")]),
  requirements: Type.Array(evidenceRequirementSchema, { minItems: 1, maxItems: 64 })
}, { additionalProperties: false });

const kindRuleSchema = Type.Object({
  kind: evidenceKind,
  allowed_assertion_origins: Type.Array(Type.Union([
    Type.Literal("tool_result"),
    Type.Literal("system_observation")
  ]), { minItems: 1, maxItems: 2 }),
  allowed_source_kinds: Type.Array(Type.Union([
    Type.Literal("command_execution"),
    Type.Literal("test_runner"),
    Type.Literal("linter"),
    Type.Literal("build_system"),
    Type.Literal("git_repository"),
    Type.Literal("http_exchange"),
    Type.Literal("browser_session")
  ]), { minItems: 1, maxItems: 8 })
}, { additionalProperties: false });

const riskOverrideSchema = Type.Object({
  risk: Type.Union([
    Type.Literal("safe"),
    Type.Literal("confirm"),
    Type.Literal("high"),
    Type.Literal("forbidden")
  ]),
  additional_required_groups: Type.Array(evidenceGroupSchema, { maxItems: 32 }),
  manual_override: Type.Union([
    Type.Literal("deny"),
    Type.Literal("allow_with_human_evidence")
  ])
}, { additionalProperties: false });

export const VERIFICATION_POLICY_SCHEMA = Type.Object({
  schema_version: Type.Literal(VERIFICATION_POLICY_SCHEMA_VERSION),
  id: policyID,
  revision: Type.Integer({ minimum: 1 }),
  name: Type.String({ minLength: 1, maxLength: 256 }),
  kind_rules: Type.Array(kindRuleSchema, { maxItems: 32 }),
  required_groups: Type.Array(evidenceGroupSchema, { minItems: 1, maxItems: 64 }),
  optional_requirements: Type.Array(evidenceRequirementSchema, { maxItems: 64 }),
  risk_overrides: Type.Array(riskOverrideSchema, { maxItems: VERIFICATION_RISK_LEVELS.length })
}, { additionalProperties: false });

export const PROJECT_VERIFICATION_OVERRIDE_SCHEMA = Type.Object({
  schema_version: Type.Literal(VERIFICATION_PROJECT_OVERRIDE_SCHEMA_VERSION),
  project_id: requiredText,
  policy_id: policyID,
  base_policy_revision: Type.Integer({ minimum: 1 }),
  additional_required_groups: Type.Array(evidenceGroupSchema, { maxItems: 64 }),
  promote_optional_requirement_ids: Type.Array(id, { maxItems: 64 }),
  disallow_skip_requirement_ids: Type.Array(id, { maxItems: 64 }),
  deny_manual_override: Type.Boolean(),
  audit_event_ref: requiredText
}, { additionalProperties: false });

type VerificationPolicySchemaValue = Static<typeof VERIFICATION_POLICY_SCHEMA>;
type ProjectVerificationOverrideSchemaValue = Static<typeof PROJECT_VERIFICATION_OVERRIDE_SCHEMA>;
export type EvidenceFactAssertion = Static<typeof factAssertionSchema>;
export type EvidenceRequirement = Omit<Static<typeof evidenceRequirementSchema>, "evidence_kinds"> & {
  evidence_kinds: EvidenceKind[];
};
export type EvidenceRequirementGroup = Omit<Static<typeof evidenceGroupSchema>, "requirements"> & {
  requirements: EvidenceRequirement[];
};
export type VerificationKindRule = Omit<Static<typeof kindRuleSchema>, "kind"> & { kind: EvidenceKind };
export type VerificationRiskOverride = Omit<Static<typeof riskOverrideSchema>, "additional_required_groups"> & {
  additional_required_groups: EvidenceRequirementGroup[];
};
export type WorkflowVerificationPolicy = Omit<
  VerificationPolicySchemaValue,
  "kind_rules" | "optional_requirements" | "required_groups" | "risk_overrides"
> & {
  kind_rules: VerificationKindRule[];
  optional_requirements: EvidenceRequirement[];
  required_groups: EvidenceRequirementGroup[];
  risk_overrides: VerificationRiskOverride[];
};
export type ProjectVerificationOverride = Omit<
  ProjectVerificationOverrideSchemaValue,
  "additional_required_groups"
> & { additional_required_groups: EvidenceRequirementGroup[] };

export type VerificationSkipDecision = {
  audit_event_ref: string;
  human_evidence_id: EvidenceID;
  reason: string;
  reason_code: string;
  requirement_id: string;
};

export type VerificationManualOverride = {
  audit_event_ref: string;
  human_evidence_id: EvidenceID;
  reason: string;
};

export type VerificationEvaluationContext = {
  attempt_id?: RunAttemptID;
  now: string;
  project_id: string;
  risk: VerificationRiskLevel;
  run_id?: RunID;
  work_id: WorkID;
};

export type EvaluateVerificationPolicyInput = {
  artifact_availability?: Readonly<Record<string, boolean>>;
  context: VerificationEvaluationContext;
  evidence: readonly EvidenceRecord[];
  manual_override?: VerificationManualOverride;
  policy: WorkflowVerificationPolicy;
  project_override?: ProjectVerificationOverride;
  skip_decisions?: readonly VerificationSkipDecision[];
};

export type VerificationRequirementStatus = "passed" | "skipped" | "missing" | "pending" | "failed";
export type VerificationRequirementResult = {
  evidence_id?: EvidenceID;
  reason: string;
  requirement_id: string;
  status: VerificationRequirementStatus;
};
export type VerificationGroupResult = {
  group_id: string;
  operator: "all" | "any";
  requirements: VerificationRequirementResult[];
  status: "passed" | "pending" | "failed";
};
export type VerificationOverrideResult = {
  applied: boolean;
  evidence_id?: EvidenceID;
  reasons: string[];
};
export type VerificationPolicyDecision = "passed" | "pending" | "failed" | "overridden" | "invalid";
export type VerificationPolicyEvaluation = {
  applied_project_override: boolean;
  applied_risk_override: boolean;
  decision: VerificationPolicyDecision;
  errors: string[];
  groups: VerificationGroupResult[];
  optional_requirements: VerificationRequirementResult[];
  override: VerificationOverrideResult;
  policy_ref: string;
  satisfied: boolean;
};
export type VerificationContractValidation = { errors: string[]; ok: boolean };

type EffectivePolicy = {
  groups: EvidenceRequirementGroup[];
  kindRules: Map<string, VerificationKindRule>;
  manualOverride: "deny" | "allow_with_human_evidence";
  optionalRequirements: EvidenceRequirement[];
};

type EvidenceIndex = {
  active: EvidenceRecord[];
};

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

function validateEvaluationInput(input: EvaluateVerificationPolicyInput): string[] {
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

function effectivePolicy(
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

function indexEvidence(evidence: readonly EvidenceRecord[], workID: WorkID): EvidenceIndex {
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

function evaluateRequirement(input: {
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

function evaluateGroup(
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

function groupDecision(groups: readonly VerificationGroupResult[]): "passed" | "pending" | "failed" {
  if (groups.every((group) => group.status === "passed")) return "passed";
  if (groups.some((group) => group.status === "failed")) return "failed";
  return "pending";
}

function evaluateManualOverride(input: {
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

function canEvidenceSatisfyPolicy(
  evidence: EvidenceRecord,
  kindRules: Map<string, VerificationKindRule>
): boolean {
  if (isKnownEvidenceKind(evidence.kind)) return canSatisfyEvidenceGate(evidence);
  const rule = kindRules.get(evidence.kind);
  if (!rule) return false;
  return evidence.status === "passed" &&
    rule.allowed_assertion_origins.some((origin) => origin === evidence.provenance.assertion_origin) &&
    rule.allowed_source_kinds.some((source) => source === evidence.provenance.source_kind) &&
    !["agent_claim", "legacy_import"].includes(evidence.provenance.assertion_origin);
}

function matchesScope(
  evidence: EvidenceRecord,
  scope: EvidenceRequirement["scope"],
  context: VerificationEvaluationContext
): boolean {
  if (scope === "work") return true;
  if (scope === "run") return evidence.run_id === context.run_id;
  return evidence.run_id === context.run_id && evidence.attempt_id === context.attempt_id;
}

function matchesSelectorFacts(
  evidence: EvidenceRecord,
  selectorFacts: EvidenceRequirement["selector_facts"]
): boolean {
  return Object.entries(selectorFacts ?? {}).every(([key, expected]) =>
    Object.is(evidence.decisive_output.facts[key], expected)
  );
}

function factAssertionPasses(
  assertion: EvidenceFactAssertion,
  facts: EvidenceRecord["decisive_output"]["facts"]
): boolean {
  if (!Object.hasOwn(facts, assertion.key)) return false;
  const actual = facts[assertion.key];
  if (assertion.operator === "equals") return Object.is(actual, assertion.expected);
  if (assertion.operator === "not_equals") return !Object.is(actual, assertion.expected);
  if (assertion.operator === "truthy") return Boolean(actual);
  return !actual;
}

function latestEvidenceFirst(left: EvidenceRecord, right: EvidenceRecord): number {
  return right.observed_at.localeCompare(left.observed_at) ||
    right.updated_at.localeCompare(left.updated_at) ||
    right.id.localeCompare(left.id);
}

function requirementResult(
  requirementID: string,
  status: VerificationRequirementStatus,
  reason: string,
  evidenceID?: EvidenceID
): VerificationRequirementResult {
  return { requirement_id: requirementID, status, reason, ...(evidenceID ? { evidence_id: evidenceID } : {}) };
}

function invalidEvaluation(policyRef: string, errors: string[]): VerificationPolicyEvaluation {
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
