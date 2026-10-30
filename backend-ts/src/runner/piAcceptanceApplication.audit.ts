import type { RunnerDatabase } from "../db/database.ts";
import { listIssueEvents, recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { getIssue, listIssueRuns, type Issue } from "../db/repositories/issues.ts";
import { type CompletionCard } from "../domain/acceptance/completionCard.ts";
import { readIssueDecisionProjection } from "../domain/review/humanReview.ts";
import type { PiAcceptanceDecision } from "../pi/issues/issueAcceptance.ts";
import { cleanString, objectValue } from "../util/values.ts";
import { PI_ACCEPTANCE_DECISION_EVENT, PI_ACCEPTANCE_APPLIED_EVENT } from "./piAcceptanceApplication.model.ts";
import type { PiAcceptanceApplicationRuntime } from "./piAcceptanceApplication.model.ts";

export function assertCurrentCard(db: RunnerDatabase, card: CompletionCard): void {
  const issue = mustGetIssue(db, card.issue.id);
  if (issue.status !== "in_progress") {
    throw new Error(`PI acceptance requires in_progress; Issue is ${issue.status}`);
  }
  const run = listIssueRuns(db, issue.id).at(-1);
  if (!run || run.id !== card.run.id || run.ended_at === "") {
    throw new Error("PI acceptance completion card is stale for the latest canonical Run");
  }
  if (issue.updated_at !== card.issue.updated_at) {
    throw new Error("PI acceptance completion card is stale for the current Issue revision");
  }
  if (readIssueDecisionProjection(db, issue.id).owner !== "pi") {
    throw new Error("PI acceptance cannot bypass an open human review request");
  }
}

export function recordDecision(db: RunnerDatabase, card: CompletionCard, decision: PiAcceptanceDecision): void {
  const exists = listIssueEvents(db, card.issue.id, {
    limit: 50,
    types: [PI_ACCEPTANCE_DECISION_EVENT]
  }).some((event) => cleanString(objectValue(parseJson(event.payload)).card_fingerprint) === card.fingerprint);
  if (exists) return;
  recordIssueEvent(db, card.issue.id, PI_ACCEPTANCE_DECISION_EVENT, {
    card_fingerprint: card.fingerprint,
    decision,
    issue_updated_at: card.issue.updated_at,
    run_id: card.run.id
  });
}

export function applied(db: RunnerDatabase, issueID: number, fingerprint: string): boolean {
  return listIssueEvents(db, issueID, { limit: 50, types: [PI_ACCEPTANCE_APPLIED_EVENT] })
    .some((event) => cleanString(objectValue(parseJson(event.payload)).card_fingerprint) === fingerprint);
}

export function publishStatus(runtime: PiAcceptanceApplicationRuntime, issue: Issue): void {
  runtime.bus?.publish({
    issueId: issue.id,
    payload: JSON.stringify({ status: issue.status }),
    projectId: issue.project_id,
    type: "issue.status_changed"
  });
}

export function mustGetIssue(db: RunnerDatabase, issueID: number): Issue {
  const issue = getIssue(db, issueID);
  if (!issue) throw new Error(`Issue #${issueID} not found`);
  return issue;
}

export function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}
