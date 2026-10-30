import { safelyRequestMemoryReflection } from "../pi/memory/memoryReflectionQueue.ts";
import { recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { type Issue } from "../db/repositories/issues.ts";
import { recordIssueCompletionCard, type CompletionCard } from "../domain/acceptance/completionCard.ts";
import { createHumanReviewRequest } from "../domain/review/humanReview.ts";
import type { PiAcceptanceDecision } from "../pi/issues/issueAcceptance.ts";
import { applyPiSemanticIssueStatus } from "./piIssueLifecycle.ts";
import { prepareAcceptedDelivery, ACCEPTED_DELIVERY_SOURCE } from "../domain/handoff/acceptedDelivery.ts";
import { recordEvidenceRecords } from "../db/repositories/evidence.ts";
import { recordHandoffDelivery } from "../notifications/handoffNotifier.ts";
import { assertPriorExecutionEvidenceFresh, assertPriorExecutionEvidenceLedgerFresh } from "../domain/acceptance/priorExecutionEvidence.ts";
import { PI_ACCEPTANCE_APPLIED_EVENT } from "./piAcceptanceApplication.model.ts";
import type { PiAcceptanceApplicationRuntime } from "./piAcceptanceApplication.model.ts";
import { mustGetIssue, applied, assertCurrentCard, recordDecision, publishStatus } from "./piAcceptanceApplication.audit.ts";

export async function acceptIssue(
  runtime: PiAcceptanceApplicationRuntime,
  card: CompletionCard,
  decision: PiAcceptanceDecision
): Promise<Issue> {
  const db = runtime.database;
  // Git 只读观察在事务外准备；事务内再次校验版本，原子保存终态与交付账本。
  const delivery = await prepareAcceptedDelivery(db, card, decision);
  await assertPriorExecutionEvidenceFresh(db, card);
  const result = db.transaction(() => {
    const current = mustGetIssue(db, card.issue.id);
    if (current.status === "done" && applied(db, current.id, card.fingerprint)) return { issue: current, notification: null };
    assertCurrentCard(db, card);
    assertPriorExecutionEvidenceLedgerFresh(db, card);
    recordDecision(db, card, decision);
    recordIssueCompletionCard(db, card, ACCEPTED_DELIVERY_SOURCE);
    recordEvidenceRecords(db, card.issue.id, delivery.evidence, { recorded_at: delivery.recorded_at, source: ACCEPTED_DELIVERY_SOURCE });
    const receipt = recordHandoffDelivery({ database: db, issue_id: card.issue.id, handoff: delivery.handoff,
      recorded_at: delivery.recorded_at, source: ACCEPTED_DELIVERY_SOURCE });
    const issue = applyPiSemanticIssueStatus(db, card.issue.id, {
      card_fingerprint: card.fingerprint, decision: decision.decision, reason: decision.rationale,
      run_id: card.run.id, status: "done"
    });
    recordIssueEvent(db, issue.id, PI_ACCEPTANCE_APPLIED_EVENT, {
      action: "accept", card_fingerprint: card.fingerprint, decision,
      from_status: current.status, run_id: card.run.id, status: "done"
    });
    return { issue, notification: receipt.notification };
  }).immediate();
  const write = result.issue;
  safelyRequestMemoryReflection(db, write.id);
  if (result.notification) runtime.bus?.publish({ issueId: write.id, projectId: write.project_id,
    type: "handoff.notification", status: delivery.handoff.status, payload: result.notification.payload });
  publishStatus(runtime, write);
  return write;
}

export function requestUser(
  runtime: PiAcceptanceApplicationRuntime,
  card: CompletionCard,
  decision: PiAcceptanceDecision
): Issue {
  const issue = applyPiSemanticIssueStatus(runtime.database, card.issue.id, {
    card_fingerprint: card.fingerprint,
    decision: decision.decision,
    reason: decision.rationale,
    run_id: card.run.id,
    status: "needs_user"
  });
  createHumanReviewRequest(runtime.database, card.issue.id, {
    acceptance_summary: decision.evidence_refs,
    consequences: decision.unmet_requirements.join("；"),
    evidence_refs: [`completion-card:${card.fingerprint}`, ...decision.evidence_refs],
    // 缺少结构化类型时按普通决策处理，绝不能把补充信息或授权误当成接受当前交付。
    kind: decision.human_review_kind ?? "decision",
    question: decision.rationale,
    recommendation: decision.follow_up_prompt || "请查看小结卡片并决定接受、要求调整或拒绝。"
  }, { bus: runtime.bus });
  recordIssueEvent(runtime.database, card.issue.id, PI_ACCEPTANCE_APPLIED_EVENT, {
    action: "needs_user",
    card_fingerprint: card.fingerprint,
    decision,
    run_id: card.run.id,
    status: "needs_user"
  });
  publishStatus(runtime, issue);
  return issue;
}

export function failIssue(
  runtime: PiAcceptanceApplicationRuntime,
  card: CompletionCard,
  decision: PiAcceptanceDecision
): Issue {
  const issue = runtime.database.transaction(() => {
    const failed = applyPiSemanticIssueStatus(runtime.database, card.issue.id, {
      card_fingerprint: card.fingerprint,
      decision: decision.decision,
      reason: decision.rationale,
      run_id: card.run.id,
      status: "failed"
    });
    recordIssueEvent(runtime.database, card.issue.id, PI_ACCEPTANCE_APPLIED_EVENT, {
      action: "failed",
      card_fingerprint: card.fingerprint,
      decision,
      run_id: card.run.id,
      status: "failed"
    });
    return failed;
  }).immediate();
  safelyRequestMemoryReflection(runtime.database, issue.id);
  publishStatus(runtime, issue);
  return issue;
}
