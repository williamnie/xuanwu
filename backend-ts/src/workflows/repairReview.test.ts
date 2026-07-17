import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EvidenceRecord } from "../domain/evidence/contracts.ts";
import type { ReviewerFinding, ReviewerLoopResult } from "../domain/handoff/reviewerLoop.ts";
import { validateWorkflowVerificationPolicy } from "../domain/evidence/policy.ts";
import { listBuiltinAssistantTools } from "../pi/builtinToolRegistry.ts";
import type { PiRecoveryBudgetDecision } from "../pi/recoveryBudget.ts";
import { makeDomainID } from "../xuanwu/coreDomainContracts.ts";
import { validateWorkflowManifest } from "./manifest.ts";
import { createWorkflowRegistry } from "./registry.ts";
import {
  REPAIR_DIAGNOSIS_POLICY,
  REPAIR_RECOVERY_ACTIONS,
  REPAIR_STAGE_IDS,
  REPAIR_VERIFICATION_POLICY,
  REPAIR_WORKFLOW_MANIFEST,
  REPAIR_WORKFLOW_REF,
  completeRepairWorkflow,
  planRepairWorkflow,
  repairWorkflowRegistryContributions
} from "./repair.ts";
import {
  REVIEW_EVIDENCE_POLICY,
  REVIEW_STAGE_IDS,
  REVIEW_WORKFLOW_ACTIONS,
  REVIEW_WORKFLOW_MANIFEST,
  REVIEW_WORKFLOW_REF,
  projectReviewWorkflowOutcome,
  reviewWorkflowRegistryContributions
} from "./review.ts";

const FIXTURES = resolve(import.meta.dir, "../../../docs/fixtures/workflows");
const ADR = resolve(import.meta.dir, "../../../docs/architecture/xuanwu/0056-repair-review-workflows.md");
const WORK_ID = makeDomainID("work", "issues", 689);
const BASE_EVIDENCE_ID = makeDomainID("evidence", "issue_events", "689-review-base");
const FRESH_EVIDENCE_ID = makeDomainID("evidence", "issue_events", "689-review-fresh");

describe("Repair and Review Workflows", () => {
  test("registers the two canonical manifests with exact revisions and deterministic dependencies", () => {
    expect(JSON.parse(readFileSync(resolve(FIXTURES, "repair-workflow-v1.json"), "utf8")))
      .toEqual(REPAIR_WORKFLOW_MANIFEST);
    expect(JSON.parse(readFileSync(resolve(FIXTURES, "review-workflow-v1.json"), "utf8")))
      .toEqual(REVIEW_WORKFLOW_MANIFEST);
    expect(validateWorkflowManifest(REPAIR_WORKFLOW_MANIFEST)).toEqual({ issues: [], ok: true });
    expect(validateWorkflowManifest(REVIEW_WORKFLOW_MANIFEST)).toEqual({ issues: [], ok: true });
    for (const policy of [REPAIR_DIAGNOSIS_POLICY, REPAIR_VERIFICATION_POLICY, REVIEW_EVIDENCE_POLICY]) {
      expect(validateWorkflowVerificationPolicy(policy)).toEqual({ errors: [], ok: true });
    }

    const registry = workflowRegistry();
    expect(registry.diagnostics).toEqual([]);
    expect(registry.resolve(REPAIR_WORKFLOW_REF)).toMatchObject({
      ok: true,
      resolution: { manifest_ref: "workflow:repair@1" }
    });
    expect(registry.resolve(REVIEW_WORKFLOW_REF)).toMatchObject({
      ok: true,
      resolution: { manifest_ref: "workflow:review@1" }
    });
  });

  test("keeps code inspection read-only and fails closed when a review mutation action is unavailable", () => {
    expect(REPAIR_WORKFLOW_MANIFEST.stages.map((stage) => stage.id)).toEqual([...REPAIR_STAGE_IDS]);
    expect(REVIEW_WORKFLOW_MANIFEST.stages.map((stage) => stage.id)).toEqual([...REVIEW_STAGE_IDS]);
    for (const stage of REVIEW_WORKFLOW_MANIFEST.stages.filter((item) => ["scope", "inspect"].includes(item.id))) {
      expect(stage.permissions.max_tool_permission).toBe("read");
      expect(stage.permissions.allowed_actions).toEqual([]);
    }

    const repair = repairWorkflowRegistryContributions();
    const review = reviewWorkflowRegistryContributions();
    const registry = createWorkflowRegistry({
      agent_profile_ids: [],
      available_actions: [...REPAIR_RECOVERY_ACTIONS],
      manifests: [...repair.manifests, ...review.manifests],
      skills: [],
      tools: listBuiltinAssistantTools(),
      verification_policies: [...repair.verification_policies, ...review.verification_policies]
    });
    expect(registry.diagnostics).toContainEqual(expect.objectContaining({
      code: "missing_action",
      message: "allowed action missing: handoff.review_decide",
      workflow_ref: REVIEW_WORKFLOW_REF
    }));
    expect(registry.resolve(REVIEW_WORKFLOW_REF)).toMatchObject({ ok: false });
    expect(registry.resolve(REPAIR_WORKFLOW_REF)).toMatchObject({ ok: true });
  });

  test("routes transient failure through one budgeted recovery and requires fresh passed Evidence", () => {
    const diagnosis = evidence("repair-transient-diagnosis", {
      diagnosis_code: "provider_timeout"
    });
    const plan = planRepairWorkflow({
      ...repairInput(diagnosis, allowBudget()),
      diagnosis_code: "provider_timeout",
      provider_session_id: "codex:thread-689"
    });

    expect(plan).toMatchObject({
      action_type: "session.resume_followup",
      budget: { issue_budget_remaining: 3, status: "allow" },
      diagnosis: { failure_class: "transient" },
      failure_class: "transient",
      handoff: { mode: "continue" },
      status: "ready"
    });
    const verification = evidence("repair-transient-verified", { outcome: "passed" }, "test");
    expect(completeRepairWorkflow(plan, {
      action_audit_event_ref: "pi_action_events:689:resume:outcome",
      action_outcome: "succeeded",
      action_type: plan.action_type,
      verification_evidence: [verification]
    })).toMatchObject({
      evidence_ids: [diagnosis.id, verification.id],
      outcome: "recovered"
    });

    expect(() => completeRepairWorkflow(plan, {
      action_audit_event_ref: "pi_action_events:689:resume:outcome",
      action_outcome: "succeeded",
      action_type: plan.action_type,
      verification_evidence: [diagnosis]
    })).toThrow(`Repair verification Evidence is not fresh: ${diagnosis.id}`);

    expect(() => planRepairWorkflow({
      ...repairInput(diagnosis, allowBudget()),
      allowed_actions: ["needs_user.escalate"],
      diagnosis_code: "provider_timeout",
      provider_session_id: "codex:thread-689"
    })).toThrow("Repair action session.resume_followup is not authorized by the deterministic gate policy");

    const forged = structuredClone(plan);
    (forged.action_candidate.gate_policy as Record<string, unknown>).authorizedActions = [];
    expect(() => completeRepairWorkflow(forged, {
      action_audit_event_ref: "pi_action_events:689:forged",
      action_outcome: "succeeded",
      action_type: forged.action_type,
      verification_evidence: [verification]
    })).toThrow("Repair action session.resume_followup is not authorized by the deterministic gate policy");
  });

  test("stops permanent failure and budget exhaustion at audited handoff/replan", () => {
    const permanentEvidence = evidence("repair-permanent-diagnosis", { diagnosis_code: "auth_required" });
    const permanent = planRepairWorkflow({
      ...repairInput(permanentEvidence, allowBudget()),
      diagnosis_code: "auth_required"
    });
    expect(permanent).toMatchObject({
      action_type: "needs_user.escalate",
      diagnosis: { failure_class: "needs_context" },
      failure_class: "permanent",
      handoff: { mode: "replan" }
    });
    expect(completeRepairWorkflow(permanent, {
      action_audit_event_ref: "pi_action_events:689:permanent:escalated",
      action_outcome: "succeeded",
      action_type: permanent.action_type,
      verification_evidence: []
    })).toMatchObject({ outcome: "replan_required" });

    const exhaustedEvidence = evidence("repair-budget-diagnosis", { diagnosis_code: "provider_timeout" });
    const exhausted = planRepairWorkflow({
      ...repairInput(exhaustedEvidence, exhaustedBudget()),
      diagnosis_code: "provider_timeout"
    });
    expect(exhausted).toMatchObject({
      action_type: "needs_user.escalate",
      budget: {
        diagnosis_code: "recovery_budget_exhausted",
        issue_budget_remaining: 0,
        status: "issue_budget_exhausted"
      },
      diagnosis: { failure_class: "exhausted" },
      failure_class: "budget_exhausted",
      handoff: { mode: "replan" }
    });
    expect(completeRepairWorkflow(exhausted, {
      action_audit_event_ref: "pi_action_events:689:budget:escalated",
      action_outcome: "succeeded",
      action_type: exhausted.action_type,
      verification_evidence: []
    })).toMatchObject({ outcome: "replan_required" });
  });

  test("projects review pass and request_changes history without replacing Reviewer Loop authority", () => {
    const accepted = reviewResult("accepted", [cycle(1, "accept", "pass", [BASE_EVIDENCE_ID])]);
    expect(projectReviewWorkflowOutcome(accepted)).toMatchObject({
      outcome: "accepted",
      repair_run_ids: [],
      replan: null
    });

    const changedThenAccepted = reviewResult("accepted", [
      cycle(1, "request_changes", "fail", [BASE_EVIDENCE_ID]),
      cycle(2, "accept", "pass", [BASE_EVIDENCE_ID, FRESH_EVIDENCE_ID], [FRESH_EVIDENCE_ID])
    ], [repairRelation(1)]);
    const projection = projectReviewWorkflowOutcome(changedThenAccepted);
    expect(projection.findings.map((finding) => finding.action)).toEqual(["request_changes", "accept"]);
    expect(projection.repair_run_ids).toEqual([makeDomainID("run", "issue_runs", "689-repair-1")]);
    expect(projection.evidence_ids).toEqual([BASE_EVIDENCE_ID, FRESH_EVIDENCE_ID]);
    expect(projection.replan).toBeNull();
  });

  test("turns final request_changes budget exhaustion into an explicit Repair replan", () => {
    const result = reviewResult("budget_exhausted", [
      cycle(1, "request_changes", "fail", [BASE_EVIDENCE_ID]),
      cycle(2, "request_changes", "inconclusive", [BASE_EVIDENCE_ID, FRESH_EVIDENCE_ID], [FRESH_EVIDENCE_ID])
    ], [repairRelation(1)]);
    expect(projectReviewWorkflowOutcome(result)).toMatchObject({
      outcome: "budget_exhausted",
      replan: {
        required: true,
        suggested_workflow_ref: REPAIR_WORKFLOW_REF
      }
    });

    const invalid = structuredClone(result);
    invalid.cycles[1]!.findings[0]!.result = "pass";
    invalid.evidence_history[1]!.findings[0]!.result = "pass";
    expect(() => projectReviewWorkflowOutcome(invalid))
      .toThrow("Review cycle 2 request_changes requires a non-passing finding");
  });

  test("locks source of truth, migration, rollback, and final deletion gates in the canonical ADR", () => {
    const adr = readFileSync(ADR, "utf8");
    for (const phrase of [
      "workflow:repair@1",
      "workflow:review@1",
      "recoveryBudget.ts",
      "reviewerLoop.ts",
      "P04 Evidence",
      "P05 Handoff",
      "双写：0",
      "双读：0",
      "回滚",
      "最终删除门禁"
    ]) expect(adr).toContain(phrase);
  });
});

function workflowRegistry() {
  const repair = repairWorkflowRegistryContributions();
  const review = reviewWorkflowRegistryContributions();
  return createWorkflowRegistry({
    agent_profile_ids: [],
    available_actions: [...REPAIR_RECOVERY_ACTIONS, ...REVIEW_WORKFLOW_ACTIONS],
    manifests: [...repair.manifests, ...review.manifests],
    skills: [],
    tools: listBuiltinAssistantTools(),
    verification_policies: [...repair.verification_policies, ...review.verification_policies]
  });
}

function repairInput(diagnosisEvidence: EvidenceRecord, budget: PiRecoveryBudgetDecision) {
  return {
    allowed_actions: [...REPAIR_RECOVERY_ACTIONS],
    budget,
    diagnosis_evidence: [diagnosisEvidence],
    event_id: "issue_supervisor_events:689:failure",
    handoff_audit_event_ref: "issue_events:689:repair:handoff",
    handoff_ref: "xw:handoff:derived:689-repair",
    issue_id: 689,
    project_id: "codex-issue-runner",
    provider: "codex",
    work_id: WORK_ID
  };
}

function allowBudget(): PiRecoveryBudgetDecision {
  return {
    diagnosis_code: "",
    issue_attempts_24h: 0,
    issue_budget_remaining: 3,
    issue_limit: 3,
    issue_window_started_at: "2026-07-16T04:00:00Z",
    last_action_at: "",
    last_action_type: "",
    last_attempt_id: "",
    last_attempt_status: "",
    project_attempts_1h: 0,
    project_budget_remaining: 10,
    project_defer_until: "",
    project_limit: 10,
    project_window_started_at: "2026-07-17T03:00:00Z",
    recommended_action: "allow",
    session_resume_attempts_24h: 0,
    session_resume_budget_remaining: 2,
    session_resume_limit: 2,
    status: "allow"
  };
}

function exhaustedBudget(): PiRecoveryBudgetDecision {
  return {
    ...allowBudget(),
    diagnosis_code: "recovery_budget_exhausted",
    issue_attempts_24h: 3,
    issue_budget_remaining: 0,
    last_action_at: "2026-07-17T03:55:00Z",
    last_action_type: "issue.retry",
    last_attempt_id: "recovery:689:3",
    last_attempt_status: "failed",
    recommended_action: "budget_exhausted",
    status: "issue_budget_exhausted"
  };
}

function evidence(
  suffix: string,
  facts: Record<string, boolean | number | string | null>,
  kind: "shell" | "test" = "shell"
): EvidenceRecord {
  const at = "2026-07-17T04:00:00.000Z";
  return {
    schema_version: 1,
    id: makeDomainID("evidence", "issue_events", suffix),
    work_id: WORK_ID,
    revision: 0,
    kind,
    status: "passed",
    created_at: at,
    observed_at: at,
    updated_at: at,
    completed_at: at,
    decisive_output: { summary: `${suffix} observation`, facts },
    artifact_refs: [],
    provenance: {
      assertion_origin: "tool_result",
      source_kind: kind === "test" ? "test_runner" : "command_execution",
      source_ref: `command:${suffix}`,
      audit_event_ref: `issue_events:689:${suffix}`,
      producer: { id: "runner:issue-689", kind: "runner" }
    },
    redaction: {
      status: "not_required",
      policy_ref: "redaction-policy:workflow-fixture@1",
      redacted_paths: []
    }
  };
}

function cycle(
  cycleNumber: number,
  action: "accept" | "request_changes" | "reject",
  result: "pass" | "fail" | "inconclusive",
  evidenceIDs: ReviewerLoopResult["cycles"][number]["evidence_ids"],
  freshEvidenceIDs: ReviewerLoopResult["cycles"][number]["fresh_evidence_ids"] = []
): ReviewerLoopResult["cycles"][number] {
  return {
    action,
    authorization_ref: `review-authorization:${cycleNumber}`,
    authority: "deterministic_policy",
    cycle: cycleNumber,
    decision_ref: `review-decision:${cycleNumber}`,
    evidence_ids: [...evidenceIDs],
    findings: [finding(`finding:${cycleNumber}`, result, evidenceIDs.at(-1)!)],
    fresh_evidence_ids: [...freshEvidenceIDs],
    handoff_id: makeDomainID("handoff", "derived", `689-review-${cycleNumber}`),
    policy_ref: "reviewer-loop:fixture@1",
    reviewer_ref: "provider:structured-review"
  };
}

function finding(id: string, result: "pass" | "fail" | "inconclusive", evidenceID: string): ReviewerFinding {
  return {
    acceptance_criterion_ids: ["criterion:repair-review"],
    evidence_ids: [evidenceID],
    finding_id: id,
    kind: "acceptance_criterion",
    result,
    summary: `${id} ${result}`
  };
}

function reviewResult(
  status: ReviewerLoopResult["status"],
  cycles: ReviewerLoopResult["cycles"],
  repairs: ReviewerLoopResult["repair_relations"] = []
): ReviewerLoopResult {
  const last = cycles.at(-1)!;
  return {
    cycles,
    evidence_history: cycles.map((item) => ({
      action: item.action,
      cycle: item.cycle,
      decision_ref: item.decision_ref,
      evidence_ids: [...item.evidence_ids],
      findings: item.findings.map((finding) => ({
        ...finding,
        acceptance_criterion_ids: [...finding.acceptance_criterion_ids],
        evidence_ids: [...finding.evidence_ids]
      })),
      handoff_id: item.handoff_id
    })),
    handoff: {
      id: last.handoff_id,
      evidence_ids: [...last.evidence_ids],
      review: { state: status === "accepted" ? "approved" : "pending" },
      status: "ready"
    } as ReviewerLoopResult["handoff"],
    repair_relations: repairs,
    status
  };
}

function repairRelation(cycleNumber: number): ReviewerLoopResult["repair_relations"][number] {
  return {
    actor: { id: "runner:repair-scheduler", kind: "runner" },
    audit_event_ref: `review-request:cycle:${cycleNumber}:repair-intent`,
    correlation_id: "issue-689-review",
    kind: "executes",
    occurred_at: "2026-07-17T04:00:00.000Z",
    reason: `repair review findings from cycle ${cycleNumber}`,
    run_id: makeDomainID("run", "issue_runs", `689-repair-${cycleNumber}`),
    work_id: WORK_ID
  };
}
