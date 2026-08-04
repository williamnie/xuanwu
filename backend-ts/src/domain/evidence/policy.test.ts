import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { makeDomainID, type EvidenceID, type RunID, type WorkID } from "../../xuanwu/coreDomainContracts.ts";
import {
  EVIDENCE_SCHEMA_VERSION,
  type EvidenceAssertionOrigin,
  type EvidenceKind,
  type EvidenceRecord,
  type EvidenceSourceKind
} from "./contracts.ts";
import {
  PROJECT_VERIFICATION_OVERRIDE_SCHEMA,
  VERIFICATION_POLICY_SCHEMA,
  VERIFICATION_POLICY_SCHEMA_VERSION,
  VERIFICATION_PROJECT_OVERRIDE_SCHEMA_VERSION,
  evaluateWorkflowVerificationPolicy,
  validateProjectVerificationOverride,
  validateWorkflowVerificationPolicy,
  type EvidenceRequirement,
  type ProjectVerificationOverride,
  type VerificationPolicyDecision,
  type VerificationRequirementStatus,
  type VerificationRiskLevel,
  type WorkflowVerificationPolicy
} from "./policy.ts";

const WORK_ID = makeDomainID("work", "issues", 668);
const OTHER_WORK_ID = makeDomainID("work", "issues", 999);
const RUN_ID = makeDomainID("run", "issue_runs", 77);
const ATTEMPT_ID = `${RUN_ID}~attempt:1` as const;
const NOW = "2026-07-16T10:00:00.000Z";
const ADR_PATH = resolve(import.meta.dir, "../../../../docs/architecture/xuanwu/0032-workflow-verification-policy.md");
let evidenceSequence = 0;

describe("Workflow Verification Policy schema", () => {
  test("accepts a closed registry-neutral policy and rejects undeclared fields", () => {
    const value = policy();
    expect(Value.Check(VERIFICATION_POLICY_SCHEMA, value)).toBe(true);
    expect(validateWorkflowVerificationPolicy(value)).toEqual({ errors: [], ok: true });
    expect(Value.Check(VERIFICATION_POLICY_SCHEMA, { ...value, workflow_registry_id: "coupled" })).toBe(false);
  });

  test("requires explicit trust rules before a future Evidence kind can gate completion", () => {
    const unknown = policy({
      required_groups: [group("custom", "all", [requirement("custom", ["device_attestation"])])]
    });
    expect(validateWorkflowVerificationPolicy(unknown)).toMatchObject({
      ok: false,
      errors: [expect.stringContaining("unregistered Evidence kind device_attestation")]
    });

    unknown.kind_rules = [{
      kind: "device_attestation",
      allowed_assertion_origins: ["system_observation"],
      allowed_source_kinds: ["command_execution"]
    }];
    expect(validateWorkflowVerificationPolicy(unknown)).toEqual({ errors: [], ok: true });
  });

  test("rejects duplicate requirement ids and forbidden-risk manual bypass", () => {
    const value = policy({
      optional_requirements: [requirement("test", ["browser"])],
      risk_overrides: [{
        risk: "forbidden",
        additional_required_groups: [],
        manual_override: "allow_with_human_evidence"
      }]
    });
    const validation = validateWorkflowVerificationPolicy(value);
    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain("duplicate optional requirement test");
    expect(validation.errors).toContain("forbidden risk cannot allow manual verification override");
  });

  test("documents authority, migration windows, rollback and deletion gates", () => {
    const adr = readFileSync(ADR_PATH, "utf8");
    expect(adr).toContain("Registry-neutral");
    expect(adr).toContain("本期双写窗口为 0");
    expect(adr).toContain("最多两个正式 release window");
    expect(adr).toContain("回滚");
    expect(adr).toContain("P11.03/P11.06");
    expect(adr).toContain("P04.07 才能把 evaluator 结果接入 `done`");
    expect(adr).toContain("LLM 不能通过生成 reason");
  });
});

describe("registry-neutral evaluator", () => {
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
});

describe("skip, risk and project overrides", () => {
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

  test("rejects Project override ids that would collide after optional promotion", () => {
    const base = policy({ optional_requirements: [requirement("visual", ["browser"])] });
    const duplicateRequirement = projectOverride(base, {
      additional_required_groups: [group("extra", "all", [requirement("visual", ["browser"])])],
      promote_optional_requirement_ids: ["visual"]
    });
    expect(validateProjectVerificationOverride(duplicateRequirement, base)).toMatchObject({
      ok: false,
      errors: [expect.stringContaining("requirement visual")]
    });

    const duplicateGroup = policy({
      optional_requirements: [requirement("visual", ["browser"])],
      required_groups: [group("project.visual", "all", [requirement("test", ["test"])])]
    });
    expect(validateProjectVerificationOverride(projectOverride(duplicateGroup, {
      promote_optional_requirement_ids: ["visual"]
    }), duplicateGroup)).toMatchObject({
      ok: false,
      errors: ["project override promoted group collides with project.visual"]
    });
  });
});

function evaluate(
  value: WorkflowVerificationPolicy,
  evidence: EvidenceRecord[],
  overrides: Partial<Parameters<typeof evaluateWorkflowVerificationPolicy>[0]> = {}
) {
  return evaluateWorkflowVerificationPolicy({
    policy: value,
    evidence,
    context: context(),
    ...overrides
  });
}

function policy(overrides: Partial<WorkflowVerificationPolicy> = {}): WorkflowVerificationPolicy {
  return {
    schema_version: VERIFICATION_POLICY_SCHEMA_VERSION,
    id: "verification-policy:engineering-default",
    revision: 1,
    name: "Engineering default",
    kind_rules: [],
    required_groups: [group("automated", "all", [requirement("test", ["test"])])],
    optional_requirements: [],
    risk_overrides: [],
    ...overrides
  };
}

function group(
  id: string,
  operator: "all" | "any",
  requirements: EvidenceRequirement[]
) {
  return { id, operator, requirements };
}

function requirement(id: string, evidenceKinds: EvidenceKind[]): EvidenceRequirement {
  return {
    id,
    evidence_kinds: evidenceKinds,
    scope: "work",
    fact_assertions: [],
    artifact_policy: "ignore"
  };
}

function context(overrides: Partial<{
  attempt_id: typeof ATTEMPT_ID;
  now: string;
  project_id: string;
  risk: VerificationRiskLevel;
  run_id: RunID;
  work_id: WorkID;
}> = {}) {
  return {
    work_id: WORK_ID,
    project_id: "xuanwu",
    risk: "safe" as const,
    now: NOW,
    run_id: RUN_ID,
    attempt_id: ATTEMPT_ID,
    ...overrides
  };
}

function projectOverride(
  base: WorkflowVerificationPolicy,
  overrides: Partial<ProjectVerificationOverride> = {}
): ProjectVerificationOverride {
  return {
    schema_version: VERIFICATION_PROJECT_OVERRIDE_SCHEMA_VERSION,
    project_id: "xuanwu",
    policy_id: base.id,
    base_policy_revision: base.revision,
    additional_required_groups: [],
    promote_optional_requirement_ids: [],
    disallow_skip_requirement_ids: [],
    deny_manual_override: false,
    audit_event_ref: "audit:project-settings:verification-policy",
    ...overrides
  };
}

type RecordOverrides = {
  artifact_refs?: EvidenceRecord["artifact_refs"];
  assertion_origin?: EvidenceAssertionOrigin;
  attempt_id?: typeof ATTEMPT_ID;
  facts?: EvidenceRecord["decisive_output"]["facts"];
  id?: EvidenceID;
  observed_at?: string;
  producer_kind?: EvidenceRecord["provenance"]["producer"]["kind"];
  run_id?: RunID;
  source_kind?: EvidenceSourceKind;
  work_id?: WorkID;
};

function record(
  kind: EvidenceKind,
  status: EvidenceRecord["status"],
  overrides: RecordOverrides = {}
): EvidenceRecord {
  const observedAt = overrides.observed_at ?? "2026-07-16T09:59:00.000Z";
  const sourceKind = overrides.source_kind ?? sourceKindFor(kind);
  const assertionOrigin = overrides.assertion_origin ?? (kind === "human" ? "human_attestation" : "tool_result");
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    id: overrides.id ?? evidenceID(`${kind}-${status}-${++evidenceSequence}`),
    work_id: overrides.work_id ?? WORK_ID,
    ...(overrides.run_id ? { run_id: overrides.run_id } : {}),
    ...(overrides.attempt_id ? { attempt_id: overrides.attempt_id } : {}),
    revision: 0,
    kind,
    status,
    created_at: observedAt,
    observed_at: observedAt,
    updated_at: observedAt,
    ...(status === "pending" ? {} : { completed_at: observedAt }),
    decisive_output: {
      summary: `${kind} ${status}`,
      facts: overrides.facts ?? { outcome: status }
    },
    artifact_refs: overrides.artifact_refs ?? [],
    provenance: {
      assertion_origin: assertionOrigin,
      source_kind: sourceKind,
      source_ref: `source:${kind}`,
      audit_event_ref: `audit:${kind}:${status}`,
      producer: {
        id: kind === "human" ? "user:reviewer" : "runner:verification",
        kind: overrides.producer_kind ?? (kind === "human" ? "user" : "runner")
      }
    },
    redaction: { status: "not_required", policy_ref: "evidence-redaction:v1", redacted_paths: [] }
  };
}

function humanDecision(decision: string, facts: Record<string, string | number | boolean | null>): EvidenceRecord {
  return record("human", "passed", { facts: { decision, ...facts } });
}

function sourceKindFor(kind: EvidenceKind): EvidenceSourceKind {
  if (kind === "test") return "test_runner";
  if (kind === "lint") return "linter";
  if (kind === "build") return "build_system";
  if (kind === "git") return "git_repository";
  if (kind === "http") return "http_exchange";
  if (kind === "browser") return "browser_session";
  if (kind === "human") return "human_attestation";
  return "command_execution";
}

function evidenceID(localID: string): EvidenceID {
  return makeDomainID("evidence", "issue_events", localID);
}
