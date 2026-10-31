import { expect, test } from "bun:test";

import { Value } from "@sinclair/typebox/value";

import { PROJECT_VERIFICATION_OVERRIDE_SCHEMA, validateProjectVerificationOverride } from "./policy.ts";
import {
  evaluate,
  policy,
  group,
  requirement,
  context,
  projectOverride,
  record,
  humanDecision
} from "./policyTestFixtures.ts";

export function registerPolicyTrustCases() {
  test("accepts only an allowed skip reason bound to trusted human Evidence", () => {
    const skippable = policy({
      required_groups: [group("platform", "all", [{
        ...requirement("ios", ["build"]),
        skip: { allowed_reason_codes: ["not_applicable"], requires_human_evidence: true }
      }])]
    });
    const approval = humanDecision("skip", {
      requirement_id: "ios",
      reason_code: "not_applicable"
    });
    const accepted = evaluate(skippable, [approval], {
      skip_decisions: [{
        audit_event_ref: approval.provenance.audit_event_ref,
        human_evidence_id: approval.id,
        reason: "This workflow has no iOS target",
        reason_code: "not_applicable",
        requirement_id: "ios"
      }]
    });
    expect(accepted).toMatchObject({
      decision: "passed",
      groups: [{ requirements: [{ status: "skipped", evidence_id: approval.id }] }]
    });

    const rejected = evaluate(skippable, [approval], {
      skip_decisions: [{
        audit_event_ref: approval.provenance.audit_event_ref,
        human_evidence_id: approval.id,
        reason: "Skip it",
        reason_code: "too_expensive",
        requirement_id: "ios"
      }]
    });
    expect(rejected).toMatchObject({
      decision: "pending",
      groups: [{ requirements: [{
        status: "missing",
        reason: "skip decision is not authorized and no matching Evidence"
      }] }]
    });
  });

  test("applies risk-required groups before considering a human manual override", () => {
    const highRisk = policy({
      risk_overrides: [{
        risk: "high",
        additional_required_groups: [group("security", "all", [requirement("security-review", ["human"])])],
        manual_override: "allow_with_human_evidence"
      }]
    });
    const failed = record("test", "failed");
    const approval = humanDecision("verification_override", {
      policy_id: highRisk.id,
      policy_revision: highRisk.revision,
      risk: "high"
    });
    const result = evaluate(highRisk, [failed, approval], {
      context: context({ risk: "high" }),
      manual_override: {
        audit_event_ref: approval.provenance.audit_event_ref,
        human_evidence_id: approval.id,
        reason: "Accepted after independent risk review"
      }
    });
    expect(result).toMatchObject({
      applied_risk_override: true,
      decision: "overridden",
      satisfied: true,
      override: { applied: true, evidence_id: approval.id }
    });
  });

  test("rejects manual override claims that are not trusted human approvals", () => {
    const highRisk = policy({
      risk_overrides: [{ risk: "high", additional_required_groups: [], manual_override: "allow_with_human_evidence" }]
    });
    const claim = record("human", "passed", {
      assertion_origin: "agent_claim",
      facts: {
        decision: "verification_override",
        policy_id: highRisk.id,
        policy_revision: highRisk.revision,
        risk: "high"
      },
      producer_kind: "runner",
      source_kind: "agent_statement"
    });
    const result = evaluate(highRisk, [record("test", "failed"), claim], {
      context: context({ risk: "high" }),
      manual_override: {
        audit_event_ref: claim.provenance.audit_event_ref,
        human_evidence_id: claim.id,
        reason: "Agent says it is okay"
      }
    });
    expect(result.decision).toBe("failed");
    expect(result.override).toMatchObject({ applied: false, reasons: ["manual override lacks trusted human Evidence"] });
  });

  test("project override can only tighten: promote optional, add groups, disable skip and deny manual override", () => {
    const base = policy({
      optional_requirements: [requirement("visual", ["browser"])],
      required_groups: [group("base", "all", [{
        ...requirement("test", ["test"]),
        skip: { allowed_reason_codes: ["not_applicable"], requires_human_evidence: true }
      }])],
      risk_overrides: [{ risk: "high", additional_required_groups: [], manual_override: "allow_with_human_evidence" }]
    });
    const override = projectOverride(base, {
      additional_required_groups: [group("lint", "all", [requirement("lint", ["lint"])])],
      promote_optional_requirement_ids: ["visual"],
      disallow_skip_requirement_ids: ["test"],
      deny_manual_override: true
    });
    expect(Value.Check(PROJECT_VERIFICATION_OVERRIDE_SCHEMA, override)).toBe(true);
    expect(validateProjectVerificationOverride(override, base)).toEqual({ errors: [], ok: true });

    const result = evaluate(base, [record("test", "passed"), record("lint", "passed")], {
      context: context({ risk: "high" }),
      project_override: override
    });
    expect(result).toMatchObject({ applied_project_override: true, decision: "pending" });
    expect(result.groups.find((group) => group.group_id === "project.visual")?.requirements[0]).toMatchObject({
      status: "missing"
    });

    const skipApproval = humanDecision("skip", { requirement_id: "test", reason_code: "not_applicable" });
    const skipDenied = evaluate(base, [skipApproval, record("lint", "passed"), record("browser", "passed")], {
      context: context({ risk: "high" }),
      project_override: override,
      skip_decisions: [{
        audit_event_ref: skipApproval.provenance.audit_event_ref,
        human_evidence_id: skipApproval.id,
        reason: "Would be accepted by the base policy",
        reason_code: "not_applicable",
        requirement_id: "test"
      }]
    });
    expect(skipDenied.groups.find((group) => group.group_id === "base")?.requirements[0]).toMatchObject({
      status: "missing"
    });

    const manualApproval = humanDecision("verification_override", {
      policy_id: base.id,
      policy_revision: base.revision,
      risk: "high"
    });
    const manualDenied = evaluate(base, [record("test", "failed"), manualApproval], {
      context: context({ risk: "high" }),
      manual_override: {
        audit_event_ref: manualApproval.provenance.audit_event_ref,
        human_evidence_id: manualApproval.id,
        reason: "Project settings must still deny this"
      },
      project_override: override
    });
    expect(manualDenied.override).toMatchObject({
      applied: false,
      reasons: ["manual override is denied for this risk"]
    });
  });

  test("fails closed when a project override targets a stale policy revision", () => {
    const base = policy();
    const override = projectOverride(base, { base_policy_revision: base.revision + 1 });
    const result = evaluate(base, [record("test", "passed")], { project_override: override });
    expect(result).toMatchObject({ decision: "invalid", satisfied: false });
    expect(result.errors).toContain("project override base revision is stale");
  });
}
