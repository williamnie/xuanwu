import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { redactedUserVisibleText } from "../../util/redact.ts";
import type { EvidenceRecord } from "./contracts.ts";
import type {
  EvidenceRequirement,
  VerificationPolicyDecision,
  VerificationPolicyEvaluation,
  VerificationRequirementResult,
  WorkflowVerificationPolicy
} from "./policy.ts";
import type { WorkLedgerEntry } from "../work/contracts.ts";

export const VERIFIER_REVIEW_SCHEMA_VERSION = 1 as const;
export const VERIFIER_REVIEW_SCHEMA_ID = "xw.verifier-review.v1" as const;
export const VERIFIER_REVIEW_VERDICTS = ["pass", "fail", "inconclusive"] as const;

const text = Type.String({ minLength: 1, maxLength: 4096 });
const optionalID = Type.String({ minLength: 1, maxLength: 512 });
const verdict = Type.Union(VERIFIER_REVIEW_VERDICTS.map((value) => Type.Literal(value)));
const acceptanceCriterion = Type.Object({
  description: text,
  id: optionalID,
  required: Type.Boolean(),
  verification_policy_ref: optionalID
}, { additionalProperties: false });
const evidenceInput = Type.Object({
  attempt_id: Type.Optional(optionalID),
  id: optionalID,
  kind: optionalID,
  observed_at: optionalID,
  run_id: Type.Optional(optionalID),
  status: Type.Union([
    Type.Literal("pending"), Type.Literal("passed"), Type.Literal("failed"), Type.Literal("blocked")
  ])
}, { additionalProperties: false });
const finding = Type.Object({
  acceptance_criterion_ids: Type.Array(optionalID, { maxItems: 256 }),
  evidence_ids: Type.Array(optionalID, { maxItems: 256 }),
  finding_id: optionalID,
  group_id: Type.Optional(optionalID),
  kind: Type.Union([
    Type.Literal("acceptance_criterion"), Type.Literal("policy_requirement"), Type.Literal("input_integrity")
  ]),
  requirement_id: Type.Optional(optionalID),
  result: verdict,
  summary: text
}, { additionalProperties: false });
const missingEvidenceSchema = Type.Object({
  acceptance_criterion_ids: Type.Array(optionalID, { maxItems: 256 }),
  expected_evidence_kinds: Type.Array(optionalID, { minItems: 1, maxItems: 32 }),
  reason: text,
  requirement_id: optionalID,
  scope: Type.Union([Type.Literal("work"), Type.Literal("run"), Type.Literal("attempt")])
}, { additionalProperties: false });

export const VERIFIER_REVIEW_SCHEMA = Type.Object({
  schema_version: Type.Literal(VERIFIER_REVIEW_SCHEMA_VERSION),
  schema_id: Type.Literal(VERIFIER_REVIEW_SCHEMA_ID),
  input_context: Type.Object({
    acceptance_contract_version: Type.Integer({ minimum: 1 }),
    acceptance_criteria: Type.Array(acceptanceCriterion, { minItems: 1, maxItems: 256 }),
    evaluated_at: optionalID,
    evidence: Type.Array(evidenceInput, { maxItems: 512 }),
    policy_ref: optionalID,
    projection_errors: Type.Array(text, { maxItems: 256 }),
    work_id: optionalID,
    work_revision: Type.Integer({ minimum: 0 }),
    work_status: optionalID
  }, { additionalProperties: false }),
  findings: Type.Array(finding, { minItems: 1, maxItems: 1024 }),
  verdict,
  missing_evidence: Type.Array(missingEvidenceSchema, { maxItems: 256 }),
  recommended_next_action: Type.Object({
    action: Type.Union([
      Type.Literal("complete_via_gate"),
      Type.Literal("fix_and_reverify"),
      Type.Literal("collect_missing_evidence"),
      Type.Literal("repair_review_input")
    ]),
    reason: text
  }, { additionalProperties: false }),
  gate_consistency: Type.Object({
    expected_status: Type.Union([
      Type.Literal("done"), Type.Literal("failed"), Type.Literal("pending_verification")
    ]),
    policy_decision: Type.Union([
      Type.Literal("passed"), Type.Literal("pending"), Type.Literal("failed"),
      Type.Literal("overridden"), Type.Literal("invalid")
    ]),
    satisfied: Type.Boolean()
  }, { additionalProperties: false })
}, { additionalProperties: false });

export type StructuredVerifierReview = Static<typeof VERIFIER_REVIEW_SCHEMA>;
export type VerifierReviewVerdict = StructuredVerifierReview["verdict"];
export type VerifierReviewValidation = { errors: string[]; ok: boolean };

export type BuildStructuredVerifierReviewInput = {
  evaluated_at: string;
  evidence: readonly EvidenceRecord[];
  evaluation: VerificationPolicyEvaluation;
  policy: WorkflowVerificationPolicy;
  projection_errors?: readonly string[];
  work: WorkLedgerEntry;
};

export function buildStructuredVerifierReview(
  input: BuildStructuredVerifierReviewInput
): StructuredVerifierReview {
  const expectedPolicyRef = `${input.policy.id}@${input.policy.revision}`;
  if (input.evaluation.policy_ref !== expectedPolicyRef) {
    throw new Error(`verifier review evaluation policy_ref ${input.evaluation.policy_ref} does not match ${expectedPolicyRef}`);
  }
  const evaluatedAt = canonicalTimestamp(input.evaluated_at);
  const criteria = input.work.acceptance.criteria.map((criterion) => ({
    description: safeText(criterion.description),
    id: criterion.id,
    required: criterion.required,
    verification_policy_ref: criterion.verification_policy_ref
  }));
  const criterionIDs = criteria.filter((criterion) => criterion.required).map((criterion) => criterion.id);
  const reviewVerdict = verifierVerdictForPolicyDecision(input.evaluation.decision);
  const findings = [
    ...criteria.map((criterion) => ({
      acceptance_criterion_ids: [criterion.id],
      evidence_ids: selectedEvidenceIDs(input.evaluation),
      finding_id: `acceptance:${criterion.id}`,
      kind: "acceptance_criterion" as const,
      result: reviewVerdict,
      summary: acceptanceSummary(criterion.id, reviewVerdict)
    })),
    ...requirementFindings(input.evaluation, criterionIDs),
    ...input.evaluation.errors.map((error, index) => ({
      acceptance_criterion_ids: criterionIDs,
      evidence_ids: [],
      finding_id: `input:${index + 1}`,
      kind: "input_integrity" as const,
      result: "fail" as const,
      summary: safeText(error)
    }))
  ];
  const missing = missingEvidence(input.policy, input.evaluation, criterionIDs);
  const review: StructuredVerifierReview = {
    schema_version: VERIFIER_REVIEW_SCHEMA_VERSION,
    schema_id: VERIFIER_REVIEW_SCHEMA_ID,
    input_context: {
      acceptance_contract_version: input.work.acceptance.version,
      acceptance_criteria: criteria,
      evaluated_at: evaluatedAt,
      evidence: uniqueEvidenceRecords(input.evidence).map((record) => ({
        id: record.id,
        kind: record.kind,
        observed_at: record.observed_at,
        status: record.status,
        ...(record.run_id ? { run_id: record.run_id } : {}),
        ...(record.attempt_id ? { attempt_id: record.attempt_id } : {})
      })),
      policy_ref: input.evaluation.policy_ref,
      projection_errors: (input.projection_errors ?? []).map(safeText).filter(Boolean),
      work_id: input.work.id,
      work_revision: input.work.revision,
      work_status: input.work.status
    },
    findings,
    verdict: reviewVerdict,
    missing_evidence: missing,
    recommended_next_action: recommendedNextAction(reviewVerdict, input.evaluation, missing),
    gate_consistency: {
      expected_status: verifierGateStatusForPolicyDecision(input.evaluation.decision),
      policy_decision: input.evaluation.decision,
      satisfied: input.evaluation.satisfied
    }
  };
  const validation = validateStructuredVerifierReview(review);
  if (!validation.ok) throw new Error(`structured verifier review is invalid: ${validation.errors.join("; ")}`);
  return review;
}

export function validateStructuredVerifierReview(input: unknown): VerifierReviewValidation {
  if (!Value.Check(VERIFIER_REVIEW_SCHEMA, input)) {
    return {
      errors: [...Value.Errors(VERIFIER_REVIEW_SCHEMA, input)].map((error) => (
        `schema ${error.path || "/"}: ${error.message}`
      )),
      ok: false
    };
  }
  const review = input as StructuredVerifierReview;
  const expectedStatus = verifierGateStatusForPolicyDecision(review.gate_consistency.policy_decision);
  const expectedVerdict = verifierVerdictForPolicyDecision(review.gate_consistency.policy_decision);
  const errors: string[] = [];
  if (review.gate_consistency.expected_status !== expectedStatus) {
    errors.push(`gate expected_status must be ${expectedStatus}`);
  }
  if (review.verdict !== expectedVerdict) errors.push(`verdict must be ${expectedVerdict}`);
  const satisfied = review.gate_consistency.policy_decision === "passed" ||
    review.gate_consistency.policy_decision === "overridden";
  if (review.gate_consistency.satisfied !== satisfied) errors.push(`gate satisfied must be ${satisfied}`);
  const expectedAction = review.gate_consistency.policy_decision === "invalid"
    ? "repair_review_input"
    : expectedVerdict === "pass"
      ? "complete_via_gate"
      : expectedVerdict === "fail" ? "fix_and_reverify" : "collect_missing_evidence";
  if (review.recommended_next_action.action !== expectedAction) {
    errors.push(`recommended_next_action must be ${expectedAction}`);
  }
  const evaluatedAt = Date.parse(review.input_context.evaluated_at);
  if (!Number.isFinite(evaluatedAt) || new Date(evaluatedAt).toISOString() !== review.input_context.evaluated_at) {
    errors.push("input_context evaluated_at must be a canonical ISO timestamp");
  }
  uniqueValues(review.findings.map((finding) => finding.finding_id), "finding id", errors);
  uniqueValues(review.input_context.acceptance_criteria.map((criterion) => criterion.id), "acceptance criterion id", errors);
  uniqueValues(review.input_context.evidence.map((evidence) => evidence.id), "Evidence id", errors);
  const criterionIDs = new Set(review.input_context.acceptance_criteria.map((criterion) => criterion.id));
  const evidenceIDs = new Set(review.input_context.evidence.map((evidence) => evidence.id));
  for (const finding of review.findings) {
    for (const criterionID of finding.acceptance_criterion_ids) {
      if (!criterionIDs.has(criterionID)) errors.push(`${finding.finding_id} references unknown acceptance criterion ${criterionID}`);
    }
    for (const evidenceID of finding.evidence_ids) {
      if (!evidenceIDs.has(evidenceID)) errors.push(`${finding.finding_id} references unknown Evidence ${evidenceID}`);
    }
  }
  return { errors, ok: errors.length === 0 };
}

export function parseStructuredVerifierReviewEventPayload(payload: unknown): StructuredVerifierReview | null {
  const object = parsedObject(payload);
  const candidate = object?.structured_review ?? object;
  const validation = validateStructuredVerifierReview(candidate);
  return validation.ok ? candidate as StructuredVerifierReview : null;
}

export function verifierReviewEventPayload(
  review: StructuredVerifierReview,
  metadata: { thread_id?: string; turn_id?: string } = {}
): Record<string, unknown> {
  const compatibility = legacyVerifierReportProjection(review);
  return {
    ...compatibility,
    structured_review: review,
    thread_id: metadata.thread_id?.trim() ?? "",
    turn_id: metadata.turn_id?.trim() ?? ""
  };
}

export function legacyVerifierReportProjection(review: StructuredVerifierReview): Record<string, string> {
  const accepted = review.findings.filter((finding) => finding.kind === "acceptance_criterion");
  const evidence = review.input_context.evidence;
  return {
    summary: `Structured verifier verdict: ${review.verdict}. Policy: ${review.input_context.policy_ref}.`,
    acceptanceChecklist: accepted.map((finding) => (
      `- [${finding.result === "pass" ? "x" : " "}] ${finding.acceptance_criterion_ids.join(", ")}: ${finding.result}`
    )).join("\n"),
    evidenceFound: evidence.length > 0
      ? evidence.map((item) => `- ${item.id} (${item.kind}/${item.status})`).join("\n")
      : "None",
    evidenceMissing: review.missing_evidence.length > 0
      ? review.missing_evidence.map((item) => `- ${item.requirement_id}: ${item.reason}`).join("\n")
      : "None",
    risk: review.verdict === "pass" ? "low" : review.verdict === "fail" ? "high" : "medium",
    recommendation: review.verdict === "pass" ? "accept" : review.verdict === "fail" ? "reject" : "retry"
  };
}

export function verifierVerdictForPolicyDecision(decision: VerificationPolicyDecision): VerifierReviewVerdict {
  if (decision === "passed" || decision === "overridden") return "pass";
  if (decision === "pending") return "inconclusive";
  return "fail";
}

export function verifierGateStatusForPolicyDecision(
  decision: VerificationPolicyDecision
): "done" | "failed" | "pending_verification" {
  if (decision === "passed" || decision === "overridden") return "done";
  if (decision === "pending") return "pending_verification";
  return "failed";
}

function requirementFindings(
  evaluation: VerificationPolicyEvaluation,
  criterionIDs: string[]
): StructuredVerifierReview["findings"] {
  const findings: StructuredVerifierReview["findings"] = [];
  for (const group of evaluation.groups) {
    for (const result of group.requirements) {
      findings.push(requirementFinding(result, criterionIDs, group.group_id));
    }
  }
  for (const result of evaluation.optional_requirements) {
    findings.push(requirementFinding(result, criterionIDs));
  }
  return findings;
}

function requirementFinding(
  result: VerificationRequirementResult,
  criterionIDs: string[],
  groupID?: string
): StructuredVerifierReview["findings"][number] {
  return {
    acceptance_criterion_ids: criterionIDs,
    evidence_ids: result.evidence_id ? [result.evidence_id] : [],
    finding_id: `requirement:${result.requirement_id}`,
    ...(groupID ? { group_id: groupID } : {}),
    kind: "policy_requirement",
    requirement_id: result.requirement_id,
    result: requirementVerdict(result),
    summary: safeText(result.reason)
  };
}

function missingEvidence(
  policy: WorkflowVerificationPolicy,
  evaluation: VerificationPolicyEvaluation,
  criterionIDs: string[]
): StructuredVerifierReview["missing_evidence"] {
  const requirements = requirementIndex(policy);
  const results = [
    ...evaluation.groups.flatMap((group) => group.requirements),
    ...evaluation.optional_requirements
  ];
  return results.flatMap((result) => {
    const requirement = requirements.get(result.requirement_id);
    if (!requirement || !evidenceGap(result)) return [];
    return [{
      acceptance_criterion_ids: criterionIDs,
      expected_evidence_kinds: [...requirement.evidence_kinds],
      reason: safeText(result.reason),
      requirement_id: result.requirement_id,
      scope: requirement.scope
    }];
  });
}

function requirementIndex(policy: WorkflowVerificationPolicy): Map<string, EvidenceRequirement> {
  return new Map([
    ...policy.required_groups.flatMap((group) => group.requirements),
    ...policy.optional_requirements,
    ...policy.risk_overrides.flatMap((override) => override.additional_required_groups)
      .flatMap((group) => group.requirements)
  ].map((requirement) => [requirement.id, requirement]));
}

function evidenceGap(result: VerificationRequirementResult): boolean {
  if (result.status === "missing" || result.status === "pending") return true;
  const reason = result.reason.toLowerCase();
  return result.status === "failed" && ["missing", "stale", "unavailable"].some((word) => reason.includes(word));
}

function requirementVerdict(result: VerificationRequirementResult): VerifierReviewVerdict {
  if (result.status === "passed" || result.status === "skipped") return "pass";
  if (result.status === "failed") return "fail";
  return "inconclusive";
}

function selectedEvidenceIDs(evaluation: VerificationPolicyEvaluation): string[] {
  return [...new Set([
    ...evaluation.groups.flatMap((group) => group.requirements),
    ...evaluation.optional_requirements
  ].flatMap((result) => result.evidence_id ? [result.evidence_id] : [])
    .concat(evaluation.override.evidence_id ? [evaluation.override.evidence_id] : []))];
}

function uniqueEvidenceRecords(records: readonly EvidenceRecord[]): EvidenceRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    if (seen.has(record.id)) return false;
    seen.add(record.id);
    return true;
  });
}

function acceptanceSummary(id: string, result: VerifierReviewVerdict): string {
  if (result === "pass") return `Acceptance criterion ${id} is supported by the policy decision.`;
  if (result === "fail") return `Acceptance criterion ${id} is not supported by the policy decision.`;
  return `Acceptance criterion ${id} is not yet conclusive.`;
}

function recommendedNextAction(
  reviewVerdict: VerifierReviewVerdict,
  evaluation: VerificationPolicyEvaluation,
  missing: StructuredVerifierReview["missing_evidence"]
): StructuredVerifierReview["recommended_next_action"] {
  if (evaluation.decision === "invalid") {
    return { action: "repair_review_input", reason: "Repair invalid policy or review context before retrying verification." };
  }
  if (reviewVerdict === "pass") {
    return { action: "complete_via_gate", reason: "Request the audited deterministic completion gate; the review itself cannot mutate Work state." };
  }
  if (reviewVerdict === "fail") {
    return { action: "fix_and_reverify", reason: "Fix failed verification findings and collect fresh Evidence before retrying." };
  }
  return {
    action: "collect_missing_evidence",
    reason: missing.length > 0
      ? "Collect the listed Evidence and rerun the same policy."
      : "Wait for pending Evidence or repair incomplete review context, then rerun the same policy."
  };
}

function canonicalTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new Error("verifier review evaluated_at must be an ISO timestamp");
  return timestamp.toISOString();
}

function safeText(value: string): string {
  return redactedUserVisibleText(value).slice(0, 4096) || "Unavailable";
}

function parsedObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return parsedObject(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function uniqueValues(values: readonly string[], label: string, errors: string[]): void {
  if (new Set(values).size !== values.length) errors.push(`${label} values must be unique`);
}
