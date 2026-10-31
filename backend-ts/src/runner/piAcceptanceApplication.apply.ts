import { safelyRequestMemoryReflection } from "../pi/memory/memoryReflectionQueue.ts";
import { listIssueEvents, recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { getIssue, type Issue } from "../db/repositories/issues.ts";
import { assertCompletionCardIntegrity, type CompletionCard } from "../domain/acceptance/completionCard.ts";
import type { PiAcceptanceDecision } from "../pi/issues/issueAcceptance.ts";
import { githubWorkAcceptanceProblem } from "../integrations/github/issueWorkflow.ts";
import { assertPriorEvidenceReferences, assertPriorExecutionEvidenceFresh } from "../domain/acceptance/priorExecutionEvidence.ts";
import { MAX_CONSECUTIVE_NO_PROGRESS_CONTINUATIONS } from "./piAcceptanceApplication.model.ts";
import type { PiAcceptanceApplicationRuntime } from "./piAcceptanceApplication.model.ts";
import { applied, assertCurrentCard, recordDecision } from "./piAcceptanceApplication.audit.ts";
import { honorAcceptedDeliveryReview, recordContinuationProgress } from "./piAcceptanceApplication.progress.ts";
import { acceptIssue, requestUser, failIssue } from "./piAcceptanceApplication.outcomes.ts";
import { retryInNewSession } from "./piAcceptanceApplication.retry.ts";
import { continueSameSession } from "./piAcceptanceApplication.continuation.ts";

export async function applyPiAcceptanceDecision(
  runtime: PiAcceptanceApplicationRuntime,
  card: CompletionCard,
  decision: PiAcceptanceDecision
): Promise<Issue> {
  assertCompletionCardIntegrity(card);
  const replay = getIssue(runtime.database, card.issue.id);
  if (replay?.status === "done" && applied(runtime.database, card.issue.id, card.fingerprint)) {
    safelyRequestMemoryReflection(runtime.database, card.issue.id);
    return replay;
  }
  assertCurrentCard(runtime.database, card);
  assertPriorEvidenceReferences(card, decision);
  let effectiveDecision = honorAcceptedDeliveryReview(runtime.database, card, decision);
  if (effectiveDecision.decision === "accept") await assertPriorExecutionEvidenceFresh(runtime.database, card);
  if (effectiveDecision.decision === "accept" && !(card.human_review?.action === "accept" && card.human_review.request.kind === "acceptance")) {
    const problem = githubWorkAcceptanceProblem(runtime.database, card);
    if (problem) {
      const answers = listIssueEvents(runtime.database, card.issue.id, { types: ["issue.human_review_answered.v1"], limit: 20 });
      const latestApproval = [...answers].reverse().find(event => JSON.parse(event.payload).action === "accept");
      // 新的有效人工回答允许再做有界续跑；同一回答不能在后续每个 Run 重置预算。
      const priorFailures = listIssueEvents(runtime.database, card.issue.id, {
        types: ["github.acceptance_contract_failed.v1"], limit: 20, afterID: latestApproval?.id ?? 0
      });
      const runIDs = new Set(priorFailures.map(event => JSON.parse(event.payload).run_id));
      if (!runIDs.has(card.run.id)) recordIssueEvent(runtime.database, card.issue.id, "github.acceptance_contract_failed.v1", { run_id: card.run.id, problem });
      effectiveDecision = { ...effectiveDecision,
        decision: runIDs.size >= 2 ? "needs_user" : "continue_same_session", human_review_kind: "decision",
        rationale: runIDs.size >= 2 ? `交付报告与运行事实连续无法关联，已停止重复执行；需要检查报告或集成观测数据。${problem}` : problem,
        follow_up_prompt: `${problem} 仅 prior_evidence 中 reusable 且输入/环境覆盖范围已确认的原始命令可复用；若只是报告字段缺失，不重复执行这些命令。revalidation_required 按 reasons 选择必要补验；revalidation_commands 是来源索引，不得自动重放修改或外部副作用。`, unmet_requirements: [problem] };
    }
  }
  if (effectiveDecision.decision === "accept") return acceptIssue(runtime, card, effectiveDecision);
  recordDecision(runtime.database, card, effectiveDecision);
  if (effectiveDecision.decision === "needs_user") return requestUser(runtime, card, effectiveDecision);
  if (effectiveDecision.decision === "failed") return failIssue(runtime, card, effectiveDecision);
  if (effectiveDecision.decision === "retry") return retryInNewSession(runtime, card, effectiveDecision);
  const continuation = recordContinuationProgress(runtime.database, card, effectiveDecision);
  if (continuation.noProgressStreak >= MAX_CONSECUTIVE_NO_PROGRESS_CONTINUATIONS) {
    return requestUser(runtime, card, {
      ...effectiveDecision,
      decision: "needs_user",
      human_review_kind: "decision",
      rationale: `连续 ${continuation.noProgressStreak} 个 Run 没有实质进展，Runner 已暂停自动 continue，避免原地循环和持续消耗资源。${effectiveDecision.rationale}`,
      unmet_requirements: [
        ...effectiveDecision.unmet_requirements,
        "需要人工检查当前 Provider Session，并决定继续、调整提示词、切换模型或终止。"
      ]
    });
  }
  return continueSameSession(runtime, card, effectiveDecision);
}
