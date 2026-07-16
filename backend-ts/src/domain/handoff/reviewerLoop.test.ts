import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { makeDomainID, type EvidenceStatus } from "../../xuanwu/coreDomainContracts.ts";
import type { StructuredVerifierReview } from "../evidence/verifierReview.ts";
import type { HandoffLinkContext, HandoffRecord } from "./contracts.ts";
import {
  createReviewerLoopService,
  type ReviewerDecision,
  type ReviewerDecisionAuthorization,
  type ReviewerDecisionGate,
  type ReviewerLoopAuditEvent,
  type ReviewerLoopRequest,
  type ReviewerProvider,
  type ReviewerProviderRequest,
  type ReviewerRepairRequest,
  type ReviewerRepairResult
} from "./reviewerLoop.ts";

const WORK_ID = makeDomainID("work", "issues", 678);
const INITIAL_RUN_ID = makeDomainID("run", "issue_runs", "678-initial");
const BASE_EVIDENCE_ID = makeDomainID("evidence", "issue_events", "678-base-passed");
const FAILED_EVIDENCE_ID = makeDomainID("evidence", "issue_events", "678-failed");
const REVIEW_REF = "review:678";
const NOW = "2026-07-17T03:00:00.000Z";
const ADR_PATH = resolve(import.meta.dir, "../../../../docs/architecture/xuanwu/0042-reviewer-loop.md");

describe("workflow-neutral Reviewer Loop", () => {
  test("accepts a passing structured review without creating a repair Run", async () => {
    const provider = sequenceProvider("automated", [
      (request) => structuredDecision("accept", "pass", request)
    ]);
    const fixture = serviceFixture(provider);

    const result = await fixture.service.execute(loopRequest(handoff()));

    expect(result).toMatchObject({ status: "accepted", repair_relations: [] });
    expect(result.handoff).toMatchObject({
      revision: 1,
      review: { decided_at: NOW, state: "approved" }
    });
    expect(result.cycles).toHaveLength(1);
    expect(fixture.repairs).toBe(0);
    expect(fixture.audit.map((event) => event.event_type)).toEqual([
      "handoff.review.requested.v1",
      "handoff.review.decided.v1"
    ]);
  });

  test("records a human rejection through human approval without starting repair", async () => {
    const provider = sequenceProvider("human", [
      () => ({
        action: "reject",
        decision_ref: "human-review:678:reject",
        findings: [finding("human:blocker", "fail", [FAILED_EVIDENCE_ID])],
        reviewer_ref: "user:reviewer",
        source: "human"
      })
    ]);
    const fixture = serviceFixture(provider);
    const request = loopRequest(handoff({ human: true }), "human");

    const result = await fixture.service.execute(request);

    expect(result.status).toBe("rejected");
    expect(result.handoff.review.state).toBe("pending");
    expect(result.cycles[0]).toMatchObject({
      action: "reject",
      authority: "human_approval",
      reviewer_ref: "user:reviewer"
    });
    expect(fixture.repairs).toBe(0);
  });

  test("preserves findings and Evidence history across two repair Runs before acceptance", async () => {
    const provider = sequenceProvider("automated", [
      (request) => structuredDecision("request_changes", "fail", request),
      (request) => structuredDecision("request_changes", "inconclusive", request),
      (request) => structuredDecision("accept", "pass", request)
    ]);
    const fixture = serviceFixture(provider);

    const result = await fixture.service.execute({ ...loopRequest(handoff()), max_cycles: 3 });

    expect(result.status).toBe("accepted");
    expect(result.repair_relations).toHaveLength(2);
    expect(new Set(result.repair_relations.map((relation) => relation.run_id)).size).toBe(2);
    expect(result.cycles.map((cycle) => cycle.action)).toEqual([
      "request_changes", "request_changes", "accept"
    ]);
    expect(result.cycles[1]?.fresh_evidence_ids).toEqual([freshEvidenceID(1)]);
    expect(result.cycles[2]?.fresh_evidence_ids).toEqual([freshEvidenceID(2)]);
    expect(result.evidence_history[0]?.findings[0]).toMatchObject({ result: "fail" });
    expect(result.evidence_history[2]?.evidence_ids).toEqual([
      BASE_EVIDENCE_ID,
      FAILED_EVIDENCE_ID,
      freshEvidenceID(1),
      freshEvidenceID(2)
    ]);
    expect(result.handoff.evidence_ids).toEqual(result.evidence_history[2]?.evidence_ids);
    expect(provider.requests.map((request) => request.prior_cycles.length)).toEqual([0, 1, 2]);
    expect(provider.requests[2]?.required_fresh_evidence_ids).toEqual([freshEvidenceID(2)]);
  });

  test("stops at the review cycle budget without scheduling an extra repair", async () => {
    const provider = sequenceProvider("automated", [
      (request) => structuredDecision("request_changes", "fail", request),
      (request) => structuredDecision("request_changes", "inconclusive", request)
    ]);
    const fixture = serviceFixture(provider);

    const result = await fixture.service.execute({ ...loopRequest(handoff()), max_cycles: 2 });

    expect(result.status).toBe("budget_exhausted");
    expect(result.cycles).toHaveLength(2);
    expect(result.repair_relations).toHaveLength(1);
    expect(fixture.repairs).toBe(1);
    expect(fixture.audit.at(-1)?.event_type).toBe("handoff.review.budget_exhausted.v1");
  });

  test("rejects a repair projection that overwrites an old Evidence conclusion", async () => {
    const provider = sequenceProvider("automated", [
      (request) => structuredDecision("request_changes", "fail", request)
    ]);
    const fixture = serviceFixture(provider, {
      repair(request) {
        const repaired = repairResult(request);
        repaired.handoff_context.evidence.find((item) => item.id === FAILED_EVIDENCE_ID)!.status = "passed";
        return repaired;
      }
    });

    await expect(fixture.service.execute({ ...loopRequest(handoff()), max_cycles: 2 }))
      .rejects.toThrow(`repair cannot overwrite old Evidence conclusions: ${FAILED_EVIDENCE_ID}`);
    expect(fixture.audit.at(-1)?.event_type).toBe("handoff.review.failed.v1");
  });

  test("requires re-review to consume fresh Evidence instead of reusing an old pass", async () => {
    const provider = sequenceProvider("automated", [
      (request) => structuredDecision("request_changes", "fail", request),
      () => ({
        action: "accept",
        decision_ref: "structured-review:2:stale-pass",
        reviewer_ref: "provider:structured-review",
        source: "structured_verifier",
        structured_review: structuredReview("pass", BASE_EVIDENCE_ID, "passed")
      })
    ]);
    const fixture = serviceFixture(provider);

    await expect(fixture.service.execute({ ...loopRequest(handoff()), max_cycles: 2 }))
      .rejects.toThrow("structured re-review must consume fresh Evidence from the repair Run");
    expect(fixture.repairs).toBe(1);
  });

  test("does not let provider output authorize its own decision", async () => {
    const provider = sequenceProvider("automated", [
      (request) => structuredDecision("accept", "pass", request)
    ]);
    const fixture = serviceFixture(provider, {
      gate: {
        authorize: () => ({
          allowed: false,
          authority: "deterministic_policy",
          authorization_ref: "policy-evaluation:denied",
          policy_ref: "reviewer-loop:v1",
          reason: "current authority denied the decision"
        })
      }
    });

    await expect(fixture.service.execute(loopRequest(handoff())))
      .rejects.toThrow("review decision gate denied the requested action");
    expect(fixture.repairs).toBe(0);
    expect(fixture.audit.at(-1)?.event_type).toBe("handoff.review.failed.v1");
  });

  test("documents authority, compatibility, rollback, and deletion gates", () => {
    const adr = readFileSync(ADR_PATH, "utf8");
    expect(adr).toContain("workflow-neutral");
    expect(adr).toContain("本期双写/双读窗口均为 0");
    expect(adr).toContain("旧 Evidence 结论保持 append-only");
    expect(adr).toContain("P11.03/P11.06");
    expect(adr).toContain("LLM/provider 输出不能自授权");
  });
});

function serviceFixture(
  provider: SequenceProvider,
  overrides: {
    gate?: ReviewerDecisionGate;
    repair?: (request: ReviewerRepairRequest) => ReviewerRepairResult;
  } = {}
) {
  const audit: ReviewerLoopAuditEvent[] = [];
  let repairs = 0;
  const service = createReviewerLoopService({
    audit_sink: { record: (event) => { audit.push(event); } },
    decision_gate: overrides.gate ?? gate(),
    now: () => NOW,
    providers: [provider],
    repair_run_scheduler: {
      async schedule(request) {
        repairs += 1;
        return overrides.repair?.(request) ?? repairResult(request);
      }
    }
  });
  return {
    audit,
    get repairs() { return repairs; },
    service
  };
}

type SequenceProvider = ReviewerProvider & { requests: ReviewerProviderRequest[] };

function sequenceProvider(
  mode: "automated" | "human",
  decisions: Array<(request: ReviewerProviderRequest) => ReviewerDecision>
): SequenceProvider {
  const requests: ReviewerProviderRequest[] = [];
  return {
    descriptor: { mode, provider_id: mode === "human" ? "human-review" : "structured-review" },
    requests,
    async review(request) {
      requests.push(request);
      const decision = decisions[request.cycle - 1];
      if (!decision) throw new Error(`missing fixture decision for cycle ${request.cycle}`);
      return decision(request);
    }
  };
}

function gate(): ReviewerDecisionGate {
  return {
    authorize({ decision }) {
      const human = decision.source === "human";
      return {
        allowed: true,
        authority: human ? "human_approval" : "deterministic_policy",
        authorization_ref: human ? decision.decision_ref : `policy-evaluation:${decision.decision_ref}`,
        policy_ref: human ? "human-review:v1" : "structured-verifier:v1",
        reason: human ? "authenticated human review" : "structured verifier output matches deterministic policy"
      } satisfies ReviewerDecisionAuthorization;
    }
  };
}

function loopRequest(record: HandoffRecord, mode: "automated" | "human" = "automated"): ReviewerLoopRequest {
  return {
    audit: {
      actor: { id: "runner:reviewer-loop", kind: "runner" },
      correlation_id: "issue-678-reviewer-loop"
    },
    handoff: record,
    handoff_context: contextFor(record),
    max_cycles: 1,
    mode,
    provider_id: mode === "human" ? "human-review" : "structured-review",
    request_id: "review-request:678"
  };
}

function handoff(input: { human?: boolean } = {}): HandoffRecord {
  return {
    schema_version: 1,
    id: makeDomainID("handoff", "derived", "678@initial"),
    work_id: WORK_ID,
    run_ids: [INITIAL_RUN_ID],
    evidence_ids: [BASE_EVIDENCE_ID, FAILED_EVIDENCE_ID],
    revision: 0,
    status: "ready",
    summary: "Reviewer Loop fixture",
    created_at: "2026-07-17T00:00:00.000Z",
    updated_at: "2026-07-17T01:00:00.000Z",
    baseline_revision: "git:base",
    final_revision: "git:tree-initial",
    review_ref: REVIEW_REF,
    changed_files: ["backend-ts/src/domain/handoff/reviewerLoop.ts"],
    delivery: { mode: "local_changes", working_tree_ref: "git:tree-initial" },
    delivery_actions: [],
    risks: [],
    rollback: { availability: "not_required", destructive: false, refs: [] },
    review: {
      required: input.human ?? false,
      state: "pending",
      review_ref: REVIEW_REF,
      reviewer_refs: [input.human ? "user:reviewer" : "provider:structured-review"]
    }
  };
}

function contextFor(record: HandoffRecord): HandoffLinkContext {
  return {
    evidence: record.evidence_ids.map((id) => ({ id, status: evidenceStatus(id), work_id: WORK_ID })),
    runs: record.run_ids.map((id) => ({ id, work_id: WORK_ID }))
  };
}

function evidenceStatus(id: string): EvidenceStatus {
  return id === FAILED_EVIDENCE_ID ? "failed" : "passed";
}

function structuredDecision(
  action: "accept" | "request_changes" | "reject",
  verdict: "pass" | "fail" | "inconclusive",
  request: ReviewerProviderRequest
): ReviewerDecision {
  const evidenceID = request.required_fresh_evidence_ids[0]
    ?? (verdict === "fail" ? FAILED_EVIDENCE_ID : BASE_EVIDENCE_ID);
  const item = request.handoff_context.evidence.find((candidate) => candidate.id === evidenceID);
  if (!item) throw new Error(`missing fixture Evidence ${evidenceID}`);
  return {
    action,
    decision_ref: `structured-review:${request.cycle}:${verdict}`,
    reviewer_ref: "provider:structured-review",
    source: "structured_verifier",
    structured_review: structuredReview(verdict, evidenceID, item.status)
  };
}

function structuredReview(
  verdict: "pass" | "fail" | "inconclusive",
  evidenceID: string,
  status: EvidenceStatus
): StructuredVerifierReview {
  const decision = verdict === "pass" ? "passed" : verdict === "fail" ? "failed" : "pending";
  const expectedStatus = verdict === "pass" ? "done" : verdict === "fail" ? "failed" : "pending_verification";
  const action = verdict === "pass" ? "complete_via_gate" : verdict === "fail" ? "fix_and_reverify" : "collect_missing_evidence";
  return {
    schema_version: 1,
    schema_id: "xw.verifier-review.v1",
    input_context: {
      acceptance_contract_version: 1,
      acceptance_criteria: [{
        description: "Reviewer Loop acceptance",
        id: "reviewer-loop",
        required: true,
        verification_policy_ref: "reviewer-loop:v1"
      }],
      evaluated_at: NOW,
      evidence: [{ id: evidenceID, kind: "test", observed_at: NOW, status }],
      policy_ref: "reviewer-loop:v1",
      projection_errors: [],
      work_id: WORK_ID,
      work_revision: 1,
      work_status: "pending_verification"
    },
    findings: [finding(`structured:${verdict}`, verdict, [evidenceID])],
    verdict,
    missing_evidence: [],
    recommended_next_action: { action, reason: `fixture ${verdict}` },
    gate_consistency: {
      expected_status: expectedStatus,
      policy_decision: decision,
      satisfied: verdict === "pass"
    }
  };
}

function finding(
  id: string,
  result: "pass" | "fail" | "inconclusive",
  evidenceIDs: readonly string[]
): StructuredVerifierReview["findings"][number] {
  return {
    acceptance_criterion_ids: ["reviewer-loop"],
    evidence_ids: [...evidenceIDs],
    finding_id: id,
    kind: "acceptance_criterion",
    result,
    summary: `fixture finding ${result}`
  };
}

function repairResult(request: ReviewerRepairRequest): ReviewerRepairResult {
  const freshID = freshEvidenceID(request.cycle);
  const runID = makeDomainID("run", "issue_runs", `678-repair-${request.cycle}`);
  const previous = request.previous_handoff;
  const finalRevision = `git:tree-repair-${request.cycle}`;
  const next: HandoffRecord = {
    ...previous,
    id: makeDomainID("handoff", "derived", `678@repair-${request.cycle}`),
    supersedes_id: previous.id,
    run_ids: [...previous.run_ids, runID],
    evidence_ids: [...previous.evidence_ids, freshID],
    revision: 0,
    summary: `Reviewer repair cycle ${request.cycle}`,
    updated_at: "2026-07-17T02:00:00.000Z",
    final_revision: finalRevision,
    delivery: { mode: "local_changes", working_tree_ref: finalRevision },
    review: { ...previous.review, state: "pending" }
  };
  return {
    fresh_evidence_ids: [freshID],
    handoff: next,
    handoff_context: contextFor(next),
    relation: {
      actor: { id: "runner:repair-scheduler", kind: "runner" },
      audit_event_ref: request.relation_audit_event_ref,
      correlation_id: request.correlation_id,
      kind: "executes",
      occurred_at: "2026-07-17T02:00:00.000Z",
      reason: `repair findings from cycle ${request.cycle}`,
      run_id: runID,
      work_id: request.work_id
    }
  };
}

function freshEvidenceID(cycle: number) {
  return makeDomainID("evidence", "issue_events", `678-fresh-${cycle}`);
}
