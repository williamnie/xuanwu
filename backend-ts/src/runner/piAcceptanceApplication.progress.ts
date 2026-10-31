import type { RunnerDatabase } from "../db/database.ts";
import { listIssueEvents, recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { type CompletionCard } from "../domain/acceptance/completionCard.ts";
import type { PiAcceptanceDecision } from "../pi/issues/issueAcceptance.ts";
import { cleanString, nonNegativeInteger, objectValue } from "../util/values.ts";
import { PI_CONTINUATION_PROGRESS_EVENT, PI_HUMAN_ACCEPTANCE_HONORED_EVENT } from "./piAcceptanceApplication.model.ts";
import { parseJson } from "./piAcceptanceApplication.audit.ts";

export type ContinuationProgress = {
  noProgressStreak: number;
};

export function recordContinuationProgress(
  db: RunnerDatabase,
  card: CompletionCard,
  decision: PiAcceptanceDecision
): ContinuationProgress {
  const events = listIssueEvents(db, card.issue.id, {
    limit: 500,
    types: [PI_CONTINUATION_PROGRESS_EVENT]
  });
  const existing = events.map((event) => ({ event, payload: objectValue(parseJson(event.payload)) }))
    .find(({ payload }) => cleanString(payload.card_fingerprint) === card.fingerprint);
  if (existing) return { noProgressStreak: nonNegativeInteger(existing.payload.no_progress_streak) };

  const previous = events.at(-1);
  const previousPayload = objectValue(parseJson(previous?.payload ?? ""));
  const sameSession = cleanString(previousPayload.provider_session_id) !== ""
    && cleanString(previousPayload.provider_session_id) === card.run.provider_session_id;
  const humanIntervened = card.human_review !== null
    && Date.parse(card.human_review.answered_at) > Date.parse(previous?.created_at ?? "");
  const priorStreak = sameSession && !humanIntervened
    ? nonNegativeInteger(previousPayload.no_progress_streak)
    : 0;
  const noProgressStreak = decision.progress.made_progress ? 0 : priorStreak + 1;
  recordIssueEvent(db, card.issue.id, PI_CONTINUATION_PROGRESS_EVENT, {
    card_fingerprint: card.fingerprint,
    evidence_refs: decision.progress.evidence_refs,
    made_progress: decision.progress.made_progress,
    no_progress_streak: noProgressStreak,
    progress_summary: decision.progress.summary,
    provider_session_id: card.run.provider_session_id,
    run_id: card.run.id
  });
  return { noProgressStreak };
}

export function honorAcceptedDeliveryReview(
  db: RunnerDatabase,
  card: CompletionCard,
  decision: PiAcceptanceDecision
): PiAcceptanceDecision {
  const review = card.human_review;
  if (!new Set<PiAcceptanceDecision["decision"]>([
    "continue_same_session",
    "needs_user",
    "retry"
  ]).has(decision.decision)
    || review?.action !== "accept"
    || review.request.kind !== "acceptance"
    || review.request.question === "") {
    return decision;
  }
  recordIssueEvent(db, card.issue.id, PI_HUMAN_ACCEPTANCE_HONORED_EVENT, {
    attempted_decision: decision,
    card_fingerprint: card.fingerprint,
    reason: decision.decision === "retry"
      ? "accepted delivery review forbids a fresh execution Session for the same stated criteria"
      : decision.decision === "continue_same_session"
        ? "accepted delivery review forbids continuing execution for the same stated criteria"
        : "accepted delivery review closes its stated human-only criteria",
    request_id: review.request_id,
    revision: review.review_revision,
    run_id: review.origin_run_id || card.run.id
  });
  return {
    confidence: decision.confidence,
    decision: "accept",
    evidence_refs: [...new Set([...decision.evidence_refs, `human-review:${review.request_id}`])],
    progress: decision.progress,
    rationale: `用户已明确接受当前交付及该验收请求列出的取舍；不得因同一缺口重复请求确认、继续执行或启动新的执行 Session。${decision.rationale}`,
    unmet_requirements: []
  };
}
