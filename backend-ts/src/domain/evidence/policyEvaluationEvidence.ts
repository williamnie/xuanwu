import { canSatisfyEvidenceGate, isKnownEvidenceKind, type EvidenceRecord } from "./contracts.ts";
import {
  type EvidenceRequirement,
  type VerificationEvaluationContext,
  type VerificationKindRule,
  type EvidenceFactAssertion
} from "./policyModel.ts";

export function canEvidenceSatisfyPolicy(
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

export function matchesScope(
  evidence: EvidenceRecord,
  scope: EvidenceRequirement["scope"],
  context: VerificationEvaluationContext
): boolean {
  if (scope === "work") return true;
  if (scope === "run") return evidence.run_id === context.run_id;
  return evidence.run_id === context.run_id && evidence.attempt_id === context.attempt_id;
}

export function matchesSelectorFacts(
  evidence: EvidenceRecord,
  selectorFacts: EvidenceRequirement["selector_facts"]
): boolean {
  return Object.entries(selectorFacts ?? {}).every(([key, expected]) =>
    Object.is(evidence.decisive_output.facts[key], expected)
  );
}

export function factAssertionPasses(
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

export function latestEvidenceFirst(left: EvidenceRecord, right: EvidenceRecord): number {
  return right.observed_at.localeCompare(left.observed_at) ||
    right.updated_at.localeCompare(left.updated_at) ||
    right.id.localeCompare(left.id);
}
