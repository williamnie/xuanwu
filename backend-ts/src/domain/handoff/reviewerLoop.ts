import {
  parseDomainID,
  type DomainActor,
  type EvidenceID,
  type WorkID
} from "../../xuanwu/coreDomainContracts.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import {
  validateStructuredVerifierReview,
  type StructuredVerifierReview
} from "../evidence/verifierReview.ts";
import type { RunWorkRelation } from "../run/contracts.ts";
import {
  validateHandoff,
  type HandoffLinkContext,
  type HandoffRecord
} from "./contracts.ts";

export const REVIEWER_LOOP_MAX_CYCLES = 16 as const;
export const REVIEWER_DECISIONS = ["accept", "request_changes", "reject"] as const;

export type ReviewerDecisionAction = typeof REVIEWER_DECISIONS[number];
export type ReviewerMode = "automated" | "human";
export type ReviewerFinding = StructuredVerifierReview["findings"][number];

export type ReviewerProviderDescriptor = {
  mode: ReviewerMode;
  provider_id: string;
};

type ReviewerDecisionBase = {
  action: ReviewerDecisionAction;
  decision_ref: string;
  reviewer_ref: string;
};

export type ReviewerDecision =
  | (ReviewerDecisionBase & {
      source: "structured_verifier";
      structured_review: StructuredVerifierReview;
    })
  | (ReviewerDecisionBase & {
      findings: ReviewerFinding[];
      source: "human";
    });

export type ReviewerCycleRecord = {
  action: ReviewerDecisionAction;
  authorization_ref: string;
  authority: "deterministic_policy" | "human_approval";
  cycle: number;
  decision_ref: string;
  evidence_ids: EvidenceID[];
  findings: ReviewerFinding[];
  fresh_evidence_ids: EvidenceID[];
  handoff_id: HandoffRecord["id"];
  policy_ref: string;
  reviewer_ref: string;
};

export type ReviewerProviderRequest = {
  cycle: number;
  handoff: HandoffRecord;
  handoff_context: HandoffLinkContext;
  max_cycles: number;
  prior_cycles: readonly ReviewerCycleRecord[];
  request_ref: string;
  required_fresh_evidence_ids: readonly EvidenceID[];
};

export interface ReviewerProvider {
  readonly descriptor: ReviewerProviderDescriptor;
  review(request: ReviewerProviderRequest): Promise<ReviewerDecision>;
}

export type ReviewerDecisionAuthorization = {
  allowed: boolean;
  authority: "deterministic_policy" | "human_approval";
  authorization_ref: string;
  policy_ref: string;
  reason: string;
};

export interface ReviewerDecisionGate {
  authorize(input: {
    decision: ReviewerDecision;
    handoff: HandoffRecord;
    provider: ReviewerProviderDescriptor;
    request: ReviewerLoopRequest;
  }): Promise<ReviewerDecisionAuthorization> | ReviewerDecisionAuthorization;
}

export type ReviewerLoopAuditEvent = {
  actor: DomainActor;
  correlation_id: string;
  cycle: number;
  event_id: string;
  event_type:
    | "handoff.review.requested.v1"
    | "handoff.review.decided.v1"
    | "handoff.review.repair_requested.v1"
    | "handoff.review.repair_run_created.v1"
    | "handoff.review.budget_exhausted.v1"
    | "handoff.review.failed.v1";
  facts: Record<string, boolean | number | string | null | string[]>;
  handoff_id: HandoffRecord["id"];
  occurred_at: string;
  provider_id: string;
  work_id: WorkID;
};

export interface ReviewerLoopAuditSink {
  record(event: ReviewerLoopAuditEvent): Promise<void> | void;
}

export type ReviewerRepairRequest = {
  correlation_id: string;
  cycle: number;
  findings: readonly ReviewerFinding[];
  previous_handoff: HandoffRecord;
  relation_audit_event_ref: string;
  review_decision_ref: string;
  work_id: WorkID;
};

export type ReviewerRepairResult = {
  fresh_evidence_ids: EvidenceID[];
  handoff: HandoffRecord;
  handoff_context: HandoffLinkContext;
  relation: RunWorkRelation;
};

export interface ReviewerRepairRunScheduler {
  schedule(request: ReviewerRepairRequest): Promise<ReviewerRepairResult>;
}

export type ReviewerLoopRequest = {
  audit: {
    actor: DomainActor;
    correlation_id: string;
  };
  handoff: HandoffRecord;
  handoff_context: HandoffLinkContext;
  max_cycles: number;
  mode: ReviewerMode;
  provider_id: string;
  request_id: string;
};

export type ReviewerLoopResult = {
  cycles: ReviewerCycleRecord[];
  evidence_history: Array<{
    action: ReviewerDecisionAction;
    cycle: number;
    decision_ref: string;
    evidence_ids: EvidenceID[];
    findings: ReviewerFinding[];
    handoff_id: HandoffRecord["id"];
  }>;
  handoff: HandoffRecord;
  repair_relations: RunWorkRelation[];
  status: "accepted" | "rejected" | "budget_exhausted";
};

export type ReviewerLoopServiceOptions = {
  audit_sink: ReviewerLoopAuditSink;
  decision_gate: ReviewerDecisionGate;
  now?: () => string;
  providers: readonly ReviewerProvider[];
  repair_run_scheduler: ReviewerRepairRunScheduler;
};

export function createReviewerLoopService(options: ReviewerLoopServiceOptions): {
  execute(request: ReviewerLoopRequest): Promise<ReviewerLoopResult>;
} {
  const providers = providerRegistry(options.providers);
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async execute(request) {
      const providerID = requiredText(request.provider_id, "reviewer provider id", 128);
      const provider = providers.get(providerID);
      if (!provider) throw new Error(`reviewer provider is not registered: ${providerID}`);
      validateInitialRequest(request, provider.descriptor);

      let handoff = request.handoff;
      let context = copyContext(request.handoff_context);
      let requiredFreshEvidenceIDs: EvidenceID[] = [];
      const cycles: ReviewerCycleRecord[] = [];
      const repairRelations: RunWorkRelation[] = [];

      for (let cycle = 1; cycle <= request.max_cycles; cycle += 1) {
        const requestRef = cycleEventID(request.request_id, cycle, "request");
        await options.audit_sink.record(auditEvent(request, providerID, handoff, cycle, now(),
          "handoff.review.requested.v1", {
            max_cycles: request.max_cycles,
            mode: request.mode,
            request_ref: requestRef,
            required_fresh_evidence_ids: requiredFreshEvidenceIDs
          }));

        try {
          const decision = await provider.review({
            cycle,
            handoff: copyHandoff(handoff),
            handoff_context: copyContext(context),
            max_cycles: request.max_cycles,
            prior_cycles: cycles.map(copyCycle),
            request_ref: requestRef,
            required_fresh_evidence_ids: [...requiredFreshEvidenceIDs]
          });
          validateReviewerDecision(decision, provider.descriptor, handoff, context, requiredFreshEvidenceIDs);
          const authorization = await options.decision_gate.authorize({
            decision,
            handoff,
            provider: provider.descriptor,
            request
          });
          validateAuthorization(authorization, decision);

          const findings = decisionFindings(decision);
          const record: ReviewerCycleRecord = {
            action: decision.action,
            authorization_ref: authorization.authorization_ref,
            authority: authorization.authority,
            cycle,
            decision_ref: decision.decision_ref,
            evidence_ids: [...handoff.evidence_ids],
            findings: copyFindings(findings),
            fresh_evidence_ids: [...requiredFreshEvidenceIDs],
            handoff_id: handoff.id,
            policy_ref: authorization.policy_ref,
            reviewer_ref: decision.reviewer_ref
          };
          await options.audit_sink.record(auditEvent(request, providerID, handoff, cycle, now(),
            "handoff.review.decided.v1", {
              action: decision.action,
              authorization_ref: authorization.authorization_ref,
              authority: authorization.authority,
              decision_ref: decision.decision_ref,
              evidence_ids: handoff.evidence_ids,
              finding_ids: findings.map((finding) => finding.finding_id),
              policy_ref: authorization.policy_ref,
              reviewer_ref: decision.reviewer_ref
            }));
          cycles.push(record);

          if (decision.action === "accept") {
            handoff = acceptedHandoff(handoff, context, decision.reviewer_ref, now());
            return result("accepted", handoff, cycles, repairRelations);
          }
          if (decision.action === "reject") return result("rejected", handoff, cycles, repairRelations);
          if (cycle === request.max_cycles) {
            await options.audit_sink.record(auditEvent(request, providerID, handoff, cycle, now(),
              "handoff.review.budget_exhausted.v1", {
                decision_ref: decision.decision_ref,
                max_cycles: request.max_cycles,
                repair_run_count: repairRelations.length
              }));
            return result("budget_exhausted", handoff, cycles, repairRelations);
          }

          const relationAuditRef = cycleEventID(request.request_id, cycle, "repair-intent");
          await options.audit_sink.record(auditEvent(request, providerID, handoff, cycle, now(),
            "handoff.review.repair_requested.v1", {
              decision_ref: decision.decision_ref,
              finding_ids: findings.map((finding) => finding.finding_id),
              relation_audit_event_ref: relationAuditRef
            }, relationAuditRef));
          const repaired = await options.repair_run_scheduler.schedule({
            correlation_id: request.audit.correlation_id,
            cycle,
            findings: copyFindings(findings),
            previous_handoff: copyHandoff(handoff),
            relation_audit_event_ref: relationAuditRef,
            review_decision_ref: decision.decision_ref,
            work_id: handoff.work_id
          });
          validateRepairResult(repaired, handoff, context, request, relationAuditRef);
          await options.audit_sink.record(auditEvent(request, providerID, repaired.handoff, cycle, now(),
            "handoff.review.repair_run_created.v1", {
              fresh_evidence_ids: repaired.fresh_evidence_ids,
              previous_handoff_id: handoff.id,
              relation_audit_event_ref: relationAuditRef,
              run_id: repaired.relation.run_id
            }));
          handoff = repaired.handoff;
          context = copyContext(repaired.handoff_context);
          requiredFreshEvidenceIDs = [...repaired.fresh_evidence_ids];
          repairRelations.push({ ...repaired.relation, actor: { ...repaired.relation.actor } });
        } catch (error) {
          await recordFailure(options.audit_sink, auditEvent(request, providerID, handoff, cycle, now(),
            "handoff.review.failed.v1", { error: safeError(error) }));
          throw error;
        }
      }
      throw new Error("reviewer loop exhausted without a terminal result");
    }
  };
}

function validateInitialRequest(request: ReviewerLoopRequest, provider: ReviewerProviderDescriptor): void {
  requiredText(request.request_id, "review request id", 256);
  requiredText(request.audit.actor.id, "review actor id", 256);
  requiredText(request.audit.correlation_id, "review correlation id", 256);
  if (!Number.isSafeInteger(request.max_cycles) || request.max_cycles < 1 || request.max_cycles > REVIEWER_LOOP_MAX_CYCLES) {
    throw new Error(`review max_cycles must be between 1 and ${REVIEWER_LOOP_MAX_CYCLES}`);
  }
  if (provider.mode !== request.mode) throw new Error("reviewer provider mode does not match review request");
  if (request.handoff.review.required && request.mode !== "human") {
    throw new Error("required human review cannot use an automated reviewer provider");
  }
  const validation = validateHandoff(request.handoff, request.handoff_context);
  if (!validation.ok) throw new Error(`review Handoff validation failed: ${validation.errors.join("; ")}`);
  if (request.handoff.status !== "ready") throw new Error("reviewer loop requires a ready Handoff");
  if (request.handoff.review.state !== "pending") throw new Error("reviewer loop requires pending review");
  if (!request.handoff.review.review_ref || request.handoff.review.review_ref !== request.handoff.review_ref) {
    throw new Error("reviewer loop requires one canonical Handoff review_ref");
  }
}

function validateReviewerDecision(
  decision: ReviewerDecision,
  provider: ReviewerProviderDescriptor,
  handoff: HandoffRecord,
  context: HandoffLinkContext,
  requiredFreshEvidenceIDs: readonly EvidenceID[]
): void {
  requiredText(decision.decision_ref, "review decision_ref", 8192);
  requiredText(decision.reviewer_ref, "review reviewer_ref", 8192);
  if (!REVIEWER_DECISIONS.includes(decision.action)) throw new Error("review decision action is invalid");
  if (handoff.review.reviewer_refs.length > 0 && !handoff.review.reviewer_refs.includes(decision.reviewer_ref)) {
    throw new Error("review decision reviewer_ref is not assigned to the Handoff");
  }
  if (provider.mode === "automated" && decision.source !== "structured_verifier") {
    throw new Error("automated reviewer must return a structured verifier review");
  }
  if (provider.mode === "human" && decision.source !== "human") {
    throw new Error("human reviewer must return a human decision");
  }

  const evidence = new Map(context.evidence.map((item) => [item.id, item]));
  const handoffEvidence = new Set(handoff.evidence_ids);
  const findings = decisionFindings(decision);
  if (findings.length === 0) throw new Error("review decision requires findings");
  if (new Set(findings.map((finding) => finding.finding_id)).size !== findings.length) {
    throw new Error("review finding ids must be unique");
  }
  for (const finding of findings) {
    for (const evidenceID of finding.evidence_ids) {
      if (!handoffEvidence.has(evidenceID as EvidenceID) || !evidence.has(evidenceID as EvidenceID)) {
        throw new Error(`review finding references Evidence outside the current Handoff: ${evidenceID}`);
      }
    }
  }

  if (decision.source === "structured_verifier") {
    const validation = validateStructuredVerifierReview(decision.structured_review);
    if (!validation.ok) throw new Error(`structured reviewer decision is invalid: ${validation.errors.join("; ")}`);
    if (decision.structured_review.input_context.work_id !== handoff.work_id) {
      throw new Error("structured reviewer decision belongs to another Work");
    }
    for (const item of decision.structured_review.input_context.evidence) {
      const current = evidence.get(item.id as EvidenceID);
      if (!handoffEvidence.has(item.id as EvidenceID) || !current) {
        throw new Error(`structured review references Evidence outside the current Handoff: ${item.id}`);
      }
      if (current.status !== item.status) throw new Error(`structured review Evidence status is stale: ${item.id}`);
    }
    if (requiredFreshEvidenceIDs.length > 0 && !decision.structured_review.input_context.evidence.some((item) =>
      requiredFreshEvidenceIDs.includes(item.id as EvidenceID))) {
      throw new Error("structured re-review must consume fresh Evidence from the repair Run");
    }
    const verdict = decision.structured_review.verdict;
    if (decision.action === "accept" && verdict !== "pass") throw new Error("accept requires a passing structured review");
    if (decision.action === "reject" && verdict !== "fail") throw new Error("reject requires a failing structured review");
    if (decision.action === "request_changes" && verdict === "pass") {
      throw new Error("request_changes cannot use a passing structured review");
    }
  } else {
    const results = findings.map((finding) => finding.result);
    if (decision.action === "accept" && results.some((item) => item !== "pass")) {
      throw new Error("human accept requires passing findings");
    }
    if (decision.action === "reject" && !results.includes("fail")) {
      throw new Error("human reject requires a failing finding");
    }
    if (decision.action === "request_changes" && results.every((item) => item === "pass")) {
      throw new Error("human request_changes requires a non-passing finding");
    }
  }
}

function validateAuthorization(authorization: ReviewerDecisionAuthorization, decision: ReviewerDecision): void {
  requiredText(authorization.authorization_ref, "review authorization_ref", 8192);
  requiredText(authorization.policy_ref, "review authorization policy_ref", 4096);
  requiredText(authorization.reason, "review authorization reason", 4096);
  if (!authorization.allowed) throw new Error("review decision gate denied the requested action");
  const expected = decision.source === "human" ? "human_approval" : "deterministic_policy";
  if (authorization.authority !== expected) {
    throw new Error(`${decision.source} review requires ${expected} authority`);
  }
}

function validateRepairResult(
  repaired: ReviewerRepairResult,
  previous: HandoffRecord,
  previousContext: HandoffLinkContext,
  request: ReviewerLoopRequest,
  relationAuditRef: string
): void {
  const { handoff, relation } = repaired;
  if (handoff.id === previous.id) throw new Error("repair must create a new Handoff identity");
  if (handoff.supersedes_id !== previous.id) throw new Error("repair Handoff must supersede the reviewed Handoff");
  if (handoff.work_id !== previous.work_id) throw new Error("repair Handoff belongs to another Work");
  if (handoff.status !== "ready" || handoff.review.state !== "pending") {
    throw new Error("repair Handoff must be ready with pending review");
  }
  if (handoff.review_ref !== previous.review_ref || handoff.review.review_ref !== previous.review.review_ref) {
    throw new Error("repair Handoff must preserve the review_ref");
  }

  if (parseDomainID(relation.run_id)?.kind !== "run") throw new Error("repair relation run_id is invalid");
  if (relation.kind !== "executes") throw new Error("repair relation kind must be executes");
  if (relation.work_id !== previous.work_id || relation.run_id === previous.run_ids.at(-1)) {
    throw new Error("repair relation must create a new Run for the same Work");
  }
  if (previous.run_ids.includes(relation.run_id)) throw new Error("repair relation reuses an existing Run");
  if (relation.audit_event_ref !== relationAuditRef) throw new Error("repair relation audit ref does not match the intent audit");
  if (relation.correlation_id !== request.audit.correlation_id) throw new Error("repair relation correlation id mismatch");
  requiredText(relation.actor.id, "repair relation actor id", 256);
  requiredText(relation.reason, "repair relation reason", 4096);
  canonicalTimestamp(relation.occurred_at, "repair relation occurred_at");
  if (!handoff.run_ids.includes(relation.run_id)) throw new Error("repair Handoff does not link the new Run");
  for (const runID of previous.run_ids) {
    if (!handoff.run_ids.includes(runID)) throw new Error(`repair Handoff dropped Run history: ${runID}`);
  }

  if (repaired.fresh_evidence_ids.length === 0) throw new Error("repair Run must produce fresh Evidence");
  if (new Set(repaired.fresh_evidence_ids).size !== repaired.fresh_evidence_ids.length) {
    throw new Error("repair fresh Evidence ids must be unique");
  }
  const oldEvidence = new Map(previousContext.evidence.map((item) => [item.id, item]));
  const nextEvidence = new Map(repaired.handoff_context.evidence.map((item) => [item.id, item]));
  for (const evidenceID of previous.evidence_ids) {
    const before = oldEvidence.get(evidenceID);
    const after = nextEvidence.get(evidenceID);
    if (!before || !after || before.status !== after.status || before.work_id !== after.work_id) {
      throw new Error(`repair cannot overwrite old Evidence conclusions: ${evidenceID}`);
    }
    if (!handoff.evidence_ids.includes(evidenceID)) throw new Error(`repair Handoff dropped Evidence history: ${evidenceID}`);
  }
  for (const evidenceID of repaired.fresh_evidence_ids) {
    if (oldEvidence.has(evidenceID)) throw new Error(`repair Evidence is not fresh: ${evidenceID}`);
    const item = nextEvidence.get(evidenceID);
    if (!item || item.work_id !== previous.work_id) throw new Error(`repair Evidence belongs to another Work: ${evidenceID}`);
    if (!handoff.evidence_ids.includes(evidenceID)) throw new Error(`repair Handoff does not link fresh Evidence: ${evidenceID}`);
  }
  if (!repaired.fresh_evidence_ids.some((id) => nextEvidence.get(id)?.status === "passed")) {
    throw new Error("repair Handoff requires fresh passed Evidence");
  }
  const nextRuns = new Map(repaired.handoff_context.runs.map((item) => [item.id, item]));
  for (const runID of previous.run_ids) {
    if (nextRuns.get(runID)?.work_id !== previous.work_id) throw new Error(`repair context dropped Run history: ${runID}`);
  }
  if (nextRuns.get(relation.run_id)?.work_id !== previous.work_id) {
    throw new Error("repair context does not contain the new Work/Run relation");
  }
  const validation = validateHandoff(handoff, repaired.handoff_context);
  if (!validation.ok) throw new Error(`repair Handoff validation failed: ${validation.errors.join("; ")}`);
}

function acceptedHandoff(
  handoff: HandoffRecord,
  context: HandoffLinkContext,
  reviewerRef: string,
  occurredAt: string
): HandoffRecord {
  const timestamp = canonicalTimestamp(occurredAt, "review decision timestamp");
  if (timestamp < handoff.updated_at) throw new Error("review decision timestamp cannot precede Handoff updated_at");
  const accepted: HandoffRecord = {
    ...handoff,
    revision: handoff.revision + 1,
    updated_at: timestamp,
    review: {
      ...handoff.review,
      decided_at: timestamp,
      review_ref: handoff.review_ref,
      reviewer_refs: [...new Set([...handoff.review.reviewer_refs, reviewerRef])],
      state: "approved"
    }
  };
  const validation = validateHandoff(accepted, context);
  if (!validation.ok) throw new Error(`accepted Handoff validation failed: ${validation.errors.join("; ")}`);
  return accepted;
}

function providerRegistry(providers: readonly ReviewerProvider[]): ReadonlyMap<string, ReviewerProvider> {
  const registry = new Map<string, ReviewerProvider>();
  for (const provider of providers) {
    const providerID = requiredText(provider.descriptor.provider_id, "reviewer provider id", 128);
    if (registry.has(providerID)) throw new Error(`duplicate reviewer provider id: ${providerID}`);
    if (provider.descriptor.mode !== "automated" && provider.descriptor.mode !== "human") {
      throw new Error(`reviewer provider mode is invalid: ${providerID}`);
    }
    registry.set(providerID, provider);
  }
  return registry;
}

function result(
  status: ReviewerLoopResult["status"],
  handoff: HandoffRecord,
  cycles: readonly ReviewerCycleRecord[],
  repairRelations: readonly RunWorkRelation[]
): ReviewerLoopResult {
  return {
    cycles: cycles.map(copyCycle),
    evidence_history: cycles.map((cycle) => ({
      action: cycle.action,
      cycle: cycle.cycle,
      decision_ref: cycle.decision_ref,
      evidence_ids: [...cycle.evidence_ids],
      findings: copyFindings(cycle.findings),
      handoff_id: cycle.handoff_id
    })),
    handoff,
    repair_relations: repairRelations.map((relation) => ({ ...relation, actor: { ...relation.actor } })),
    status
  };
}

function copyCycle(cycle: ReviewerCycleRecord): ReviewerCycleRecord {
  return {
    ...cycle,
    evidence_ids: [...cycle.evidence_ids],
    findings: copyFindings(cycle.findings),
    fresh_evidence_ids: [...cycle.fresh_evidence_ids]
  };
}

function copyHandoff(handoff: HandoffRecord): HandoffRecord {
  return JSON.parse(JSON.stringify(handoff)) as HandoffRecord;
}

function decisionFindings(decision: ReviewerDecision): ReviewerFinding[] {
  return decision.source === "structured_verifier" ? decision.structured_review.findings : decision.findings;
}

function copyFindings(findings: readonly ReviewerFinding[]): ReviewerFinding[] {
  return findings.map((finding) => ({
    ...finding,
    acceptance_criterion_ids: [...finding.acceptance_criterion_ids],
    evidence_ids: [...finding.evidence_ids]
  }));
}

function copyContext(context: HandoffLinkContext): HandoffLinkContext {
  return {
    evidence: context.evidence.map((item) => ({ ...item })),
    runs: context.runs.map((item) => ({ ...item }))
  };
}

function auditEvent(
  request: ReviewerLoopRequest,
  providerID: string,
  handoff: HandoffRecord,
  cycle: number,
  occurredAt: string,
  eventType: ReviewerLoopAuditEvent["event_type"],
  facts: ReviewerLoopAuditEvent["facts"],
  eventID = cycleEventID(request.request_id, cycle, eventType)
): ReviewerLoopAuditEvent {
  return {
    actor: { ...request.audit.actor },
    correlation_id: request.audit.correlation_id,
    cycle,
    event_id: eventID,
    event_type: eventType,
    facts,
    handoff_id: handoff.id,
    occurred_at: canonicalTimestamp(occurredAt, "review audit occurred_at"),
    provider_id: providerID,
    work_id: handoff.work_id
  };
}

function cycleEventID(requestID: string, cycle: number, suffix: string): string {
  return `${requestID}:cycle:${cycle}:${suffix}`;
}

async function recordFailure(sink: ReviewerLoopAuditSink, event: ReviewerLoopAuditEvent): Promise<void> {
  try {
    await sink.record(event);
  } catch {
    // Preserve the decisive provider/gate/repair failure; the primary error remains the caller-visible result.
  }
}

function requiredText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${label} is required`);
  if (normalized.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters`);
  return normalized;
}

function canonicalTimestamp(value: string, label: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Error(`${label} must be a canonical ISO timestamp`);
  return value;
}

function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}
