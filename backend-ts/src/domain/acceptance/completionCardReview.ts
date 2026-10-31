import { listIssueEvents } from "../../db/repositories/issueEvents.ts";
import { type IssueRun } from "../../db/repositories/issues.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import { cleanString, nonNegativeInteger, objectValue } from "../../util/values.ts";
import {
  type CompletionCardHumanReview,
  parseJson,
  stringArray,
  COMPLETION_CARD_EVENT_TYPE,
  integer,
  boundedUtf8,
  boundedSequence,
  type CompletionCardCommand,
  MAX_FINAL_MESSAGE_BYTES,
  type CompletionCardGit,
  TERMINAL_COMMAND_OBSERVATION_CONTRACT
} from "./completionCardModel.ts";

export function humanReviewResolution(
  events: ReturnType<typeof listIssueEvents>,
  runs: IssueRun[]
): CompletionCardHumanReview | null {
  const answered = [...events].reverse().find((event) => event.type === "issue.human_review_answered.v1");
  if (!answered) return null;
  const response = objectValue(parseJson(answered.payload));
  const requestID = cleanString(response.request_id);
  const requestEvent = [...events].reverse().find((event) => {
    if (event.type !== "issue.human_review_requested.v1") return false;
    return cleanString(objectValue(parseJson(event.payload)).id) === requestID;
  });
  const responseRequest = objectValue(response.request_snapshot);
  const request = Object.keys(responseRequest).length > 0
    ? responseRequest
    : objectValue(parseJson(requestEvent?.payload));
  const evidenceRefs = stringArray(request.evidence_refs);
  const originFingerprint = cleanString(response.origin_card_fingerprint)
    || cleanString(request.origin_card_fingerprint)
    || evidenceRefs.map((reference) => reference.match(/^completion-card:([a-f0-9]{64})$/)?.[1] ?? "")
      .find(Boolean)
    || "";
  const originEvent = [...events].reverse().find((event) => {
    if (event.type !== COMPLETION_CARD_EVENT_TYPE) return false;
    return cleanString(objectValue(parseJson(event.payload)).fingerprint) === originFingerprint;
  });
  const originCard = objectValue(objectValue(parseJson(originEvent?.payload)).card);
  const originRun = objectValue(originCard.run);
  const originRunID = cleanString(response.origin_run_id)
    || cleanString(request.origin_run_id)
    || cleanString(originRun.id);
  const originAttempt = runs.find((candidate) => candidate.id === originRunID)?.attempt ?? 0;
  const reviewRevision = integer(response.revision) ?? integer(request.revision) ?? 0;
  return {
    action: cleanString(response.action),
    answered_at: answered.created_at,
    comment: boundedUtf8(redactSensitiveText(cleanString(response.comment)), 4_000),
    intervening_runs: runs.filter((candidate) => candidate.attempt > originAttempt).map((candidate) => {
      const control = runControlOutcome(events, candidate);
      return {
        attempt: candidate.attempt,
        control_operation: control.operation,
        control_outcome: control.outcome,
        ended_at: candidate.ended_at,
        error: boundedUtf8(redactSensitiveText(candidate.error), 1_000),
        exit_reason: candidate.exit_reason,
        id: candidate.id,
        status: candidate.status
      };
    }),
    origin_card_fingerprint: originFingerprint,
    origin_completion: completionCardSummary(originCard),
    origin_run_id: originRunID,
    request: humanReviewRequestSummary(request),
    request_id: requestID,
    review_revision: reviewRevision
  };
}

function humanReviewRequestSummary(
  request: Record<string, unknown>
): CompletionCardHumanReview["request"] {
  const kind = cleanString(request.kind);
  return {
    acceptance_summary: boundedSequence(stringArray(request.acceptance_summary), 24)
      .map((value) => boundedUtf8(redactSensitiveText(value), 1_000)),
    consequences: boundedUtf8(redactSensitiveText(cleanString(request.consequences)), 4_000),
    evidence_refs: boundedSequence(stringArray(request.evidence_refs), 36)
      .map((value) => boundedUtf8(redactSensitiveText(value), 1_000)),
    excluded_scope: boundedSequence(stringArray(request.excluded_scope), 24)
      .map((value) => boundedUtf8(redactSensitiveText(value), 1_000)),
    kind: kind === "decision" || kind === "risk_acceptance" ? kind : "acceptance",
    question: boundedUtf8(redactSensitiveText(cleanString(request.question)), 4_000),
    recommendation: boundedUtf8(redactSensitiveText(cleanString(request.recommendation)), 4_000)
  };
}

function runControlOutcome(
  events: ReturnType<typeof listIssueEvents>,
  run: IssueRun
): { operation: string; outcome: string } {
  for (const event of [...events].reverse()) {
    if (event.type !== "run.lifecycle.outcome.v1") continue;
    const payload = objectValue(parseJson(event.payload));
    const issueRunID = cleanString(payload.issue_run_id);
    const runID = cleanString(payload.run_id);
    if (issueRunID !== run.id && runID !== run.id && !runID.endsWith(`:${run.id}`)) continue;
    return {
      operation: cleanString(payload.operation),
      outcome: cleanString(payload.outcome)
    };
  }
  return { operation: "", outcome: "" };
}

function completionCardSummary(card: Record<string, unknown>): CompletionCardHumanReview["origin_completion"] {
  if (Object.keys(card).length === 0) return null;
  const run = objectValue(card.run);
  const commands = objectValue(card.commands);
  const git = objectValue(card.git);
  if (cleanString(run.id) === "" || !Array.isArray(commands.items)) return null;
  return {
    commands: {
      items: commands.items as CompletionCardCommand[],
      omitted: nonNegativeInteger(commands.omitted),
      total: nonNegativeInteger(commands.total)
    },
    final_message: boundedUtf8(redactSensitiveText(cleanString(card.final_message)), MAX_FINAL_MESSAGE_BYTES),
    git: git as CompletionCardGit,
    provider_outcome: {
      outcome: cleanString(objectValue(card.provider_outcome).outcome),
      reason: boundedUtf8(redactSensitiveText(cleanString(objectValue(card.provider_outcome).reason)), 2_000)
    },
    run: {
      attempt: nonNegativeInteger(run.attempt),
      ended_at: cleanString(run.ended_at),
      id: cleanString(run.id),
      provider: cleanString(run.provider),
      provider_session_id: cleanString(run.provider_session_id),
      provider_turn_id: cleanString(run.provider_turn_id),
      started_at: cleanString(run.started_at),
      status: cleanString(run.status)
    },
    warnings: stringArray(card.warnings)
  };
}

export function hasCompleteTerminalObservationContract(
  events: ReturnType<typeof listIssueEvents>,
  run: IssueRun
): boolean {
  return events.some((event) => {
    if (event.type !== "issue.pi_acceptance_requested.v1") return false;
    const payload = objectValue(parseJson(event.payload));
    return cleanString(payload.issue_run_id) === run.id
      && cleanString(payload.command_observation_contract) === TERMINAL_COMMAND_OBSERVATION_CONTRACT;
  });
}

export function eventBelongsToRun(payload: Record<string, unknown>, createdAt: string, run: IssueRun): boolean {
  const correlation = objectValue(payload.runtime_evidence_correlation);
  const correlatedRun = cleanString(correlation.issue_run_id);
  if (correlatedRun !== "") return correlatedRun === run.id;
  const at = Date.parse(createdAt);
  const start = Date.parse(run.started_at);
  const end = Date.parse(run.ended_at);
  return Number.isFinite(at) && Number.isFinite(start) && Number.isFinite(end) && at >= start && at <= end;
}
