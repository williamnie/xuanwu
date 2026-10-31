import { expect, test } from "bun:test";

import { type EvidenceRecord } from "./contracts.ts";
import {
  evaluateWorkflowVerificationPolicy,
  type VerificationPolicyDecision,
  type VerificationRequirementStatus,
  type WorkflowVerificationPolicy
} from "./policy.ts";
import {
  OTHER_WORK_ID,
  RUN_ID,
  ATTEMPT_ID,
  evaluate,
  policy,
  group,
  requirement,
  context,
  record,
  evidenceID
} from "./policyTestFixtures.ts";

export function registerPolicyEvaluationCases() {
  const cases: Array<{
    evidence: EvidenceRecord[];
    expectedDecision: VerificationPolicyDecision;
    expectedStatuses: VerificationRequirementStatus[];
    name: string;
    policy: WorkflowVerificationPolicy;
  }> = [
    {
      name: "all: missing Evidence stays pending",
      policy: policy(),
      evidence: [],
      expectedDecision: "pending",
      expectedStatuses: ["missing"]
    },
    {
      name: "all: failed Evidence fails the policy",
      policy: policy(),
      evidence: [record("test", "failed")],
      expectedDecision: "failed",
      expectedStatuses: ["failed"]
    },
    {
      name: "all: trusted passed Evidence passes",
      policy: policy(),
      evidence: [record("test", "passed")],
      expectedDecision: "passed",
      expectedStatuses: ["passed"]
    },
    {
      name: "any: one passing alternative satisfies the group",
      policy: policy({
        required_groups: [group("smoke", "any", [
          requirement("http", ["http"]),
          requirement("browser", ["browser"])
        ])]
      }),
      evidence: [record("http", "failed"), record("browser", "passed")],
      expectedDecision: "passed",
      expectedStatuses: ["failed", "passed"]
    },
    {
      name: "any: terminal failure of every alternative fails",
      policy: policy({
        required_groups: [group("smoke", "any", [
          requirement("http", ["http"]),
          requirement("browser", ["browser"])
        ])]
      }),
      evidence: [record("http", "failed"), record("browser", "blocked")],
      expectedDecision: "failed",
      expectedStatuses: ["failed", "failed"]
    }
  ];

  for (const item of cases) {
    test(item.name, () => {
      const result = evaluate(item.policy, item.evidence);
      expect(result.decision).toBe(item.expectedDecision);
      expect(result.groups[0]?.requirements.map((requirement) => requirement.status)).toEqual(item.expectedStatuses);
      expect(result.satisfied).toBe(["passed", "overridden"].includes(item.expectedDecision));
    });
  }

  test("selects the latest matching Evidence and enforces run/attempt scope plus fact assertions", () => {
    const scoped = policy({
      required_groups: [group("scoped", "all", [{
        ...requirement("focused-test", ["test"]),
        scope: "attempt",
        selector_facts: { suite: "policy" },
        fact_assertions: [{ key: "failure_count", operator: "equals", expected: 0 }]
      }])]
    });
    const olderPass = record("test", "passed", {
      facts: { failure_count: 0, suite: "policy" },
      id: evidenceID("old"),
      observed_at: "2026-07-16T09:00:00.000Z",
      run_id: RUN_ID,
      attempt_id: ATTEMPT_ID
    });
    const newerFailure = record("test", "passed", {
      facts: { failure_count: 1, suite: "policy" },
      id: evidenceID("new"),
      observed_at: "2026-07-16T09:30:00.000Z",
      run_id: RUN_ID,
      attempt_id: ATTEMPT_ID
    });
    const result = evaluate(scoped, [olderPass, newerFailure]);
    expect(result).toMatchObject({ decision: "failed", groups: [{ requirements: [{ evidence_id: newerFailure.id }] }] });

    const missingFact = evaluate(policy({
      required_groups: [group("facts", "all", [{
        ...requirement("test", ["test"]),
        fact_assertions: [{ key: "outcome", operator: "not_equals", expected: "failed" }]
      }])]
    }), [record("test", "passed", { facts: {} })]);
    expect(missingFact).toMatchObject({
      decision: "failed",
      groups: [{ requirements: [{ reason: "Evidence fact assertion failed: outcome not_equals" }] }]
    });

    const withoutAttempt = evaluateWorkflowVerificationPolicy({
      policy: scoped,
      evidence: [olderPass],
      context: context({ attempt_id: undefined })
    });
    expect(withoutAttempt).toMatchObject({
      decision: "pending",
      groups: [{ requirements: [{ status: "missing", reason: "current Attempt scope was not provided" }] }]
    });
  });

  test("fails closed for stale or unavailable-artifact Evidence", () => {
    const strict = policy({
      required_groups: [group("visual", "all", [{
        ...requirement("browser", ["browser"]),
        artifact_policy: "available",
        max_age_seconds: 60
      }])]
    });
    const browser = record("browser", "passed", {
      artifact_refs: [{ kind: "screenshot", ref: "artifact://browser/screenshot.png" }],
      observed_at: "2026-07-16T09:59:30.000Z"
    });
    expect(evaluate(strict, [browser]).groups[0]?.requirements[0]).toMatchObject({
      status: "failed",
      reason: "artifact is unavailable: artifact://browser/screenshot.png"
    });
    expect(evaluate(strict, [browser], {
      artifact_availability: { "artifact://browser/screenshot.png": true }
    }).decision).toBe("passed");
    expect(evaluate(strict, [{ ...browser, observed_at: "2026-07-16T09:58:00.000Z" }], {
      artifact_availability: { "artifact://browser/screenshot.png": true }
    }).groups[0]?.requirements[0]).toMatchObject({ status: "failed", reason: "Evidence is stale" });
  });

  test("does not accept Evidence belonging to another Work or an Agent claim", () => {
    const wrongWork = record("test", "passed", { work_id: OTHER_WORK_ID });
    expect(evaluate(policy(), [wrongWork]).decision).toBe("pending");

    const claim = record("test", "passed", {
      assertion_origin: "agent_claim",
      source_kind: "agent_statement"
    });
    expect(evaluate(policy(), [claim])).toMatchObject({
      decision: "failed",
      groups: [{ requirements: [{ reason: "Evidence provenance is not trusted by policy" }] }]
    });

    const passed = record("test", "passed", { id: evidenceID("current-work-pass") });
    const foreignCorrection = {
      ...record("test", "failed", { work_id: OTHER_WORK_ID }),
      supersedes_id: passed.id
    };
    expect(evaluate(policy(), [passed, foreignCorrection]).decision).toBe("passed");

    const crossKindCorrection = { ...record("browser", "failed"), supersedes_id: passed.id };
    expect(evaluate(policy(), [passed, crossKindCorrection]).decision).toBe("passed");
  });

  test("allows an explicitly registered future kind without coupling to a Workflow Registry", () => {
    const custom = policy({
      kind_rules: [{
        kind: "device_attestation",
        allowed_assertion_origins: ["system_observation"],
        allowed_source_kinds: ["command_execution"]
      }],
      required_groups: [group("device", "all", [requirement("device", ["device_attestation"])])]
    });
    const result = evaluate(custom, [record("device_attestation", "passed", {
      assertion_origin: "system_observation",
      source_kind: "command_execution"
    })]);
    expect(result.decision).toBe("passed");
  });
}
