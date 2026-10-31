import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../../db/database.ts";
import { listIssueEvents, recordIssueEvent } from "../../db/repositories/issueEvents.ts";
import { getIssue, listIssueRuns } from "../../db/repositories/issues.ts";
import { getProject } from "../../db/repositories/projects.ts";
import { projectIssueAsWork } from "../work/issueAdapter.ts";
import { buildPriorExecutionEvidence } from "./priorExecutionEvidence.ts";
import { cleanString, objectValue } from "../../util/values.ts";
import {
  type CompletionCardSessionInput,
  type CompletionCard,
  COMPLETION_GIT_OBSERVATION_EVENT_TYPE,
  boundedSequence,
  MAX_COMMANDS,
  COMPLETION_CARD_CONTRACT,
  stableJson,
  COMPLETION_CARD_EVENT_TYPE,
  parseJson
} from "./completionCardModel.ts";
import { commandsFromIssueLogs, recoveredRolloutCommands, uniqueCommands } from "./completionCardCommands.ts";
import { hasCompleteTerminalObservationContract, humanReviewResolution } from "./completionCardReview.ts";
import { gitRunSummary, completionWarnings } from "./completionCardGit.ts";
import { completionSession, latestFinalMessage, providerOutcome } from "./completionCardSession.ts";

export async function buildIssueCompletionCard(
  db: RunnerDatabase,
  issueID: number,
  options: { now?: Date; session?: CompletionCardSessionInput } = {}
): Promise<CompletionCard> {
  const issue = getIssue(db, issueID);
  if (!issue) throw new Error(`Issue #${issueID} not found`);
  const project = getProject(db, issue.project_id);
  if (!project) throw new Error(`Project ${issue.project_id} not found`);
  const runs = listIssueRuns(db, issueID);
  const run = runs.at(-1);
  if (!run || run.ended_at === "") throw new Error("completion card requires an ended canonical Run");
  const work = projectIssueAsWork(db, issue);
  const events = listIssueEvents(db, issueID, {
    limit: 500,
    types: [
      "issue.log",
      "issue.runner_outcome",
      "issue.pi_acceptance_requested.v1",
      "issue.completion_card.v1",
      "issue.human_review_answered.v1",
      "issue.human_review_requested.v1",
      "run.lifecycle.outcome.v1",
      COMPLETION_GIT_OBSERVATION_EVENT_TYPE
    ]
  });
  const logCommands = commandsFromIssueLogs(events, run);
  const rolloutCommands = hasCompleteTerminalObservationContract(events, run)
    ? []
    : await recoveredRolloutCommands(run);
  const allCommands = uniqueCommands([...logCommands, ...rolloutCommands]);
  const boundedCommands = boundedSequence(allCommands, MAX_COMMANDS);
  const git = await gitRunSummary(project.cwd, run, events);
  const warnings = completionWarnings(run, allCommands, git.changed_files);
  const session = await completionSession(project.cwd, run, options.session);
  if (session.inspected && session.latest_turn_id !== "" && !session.latest_turn_matches_run) {
    warnings.push(`Provider Session has a newer Turn (${session.latest_turn_id}) than canonical Run ${run.id} (${run.provider_turn_id || "unbound"}).`);
  }
  if (session.error !== "") warnings.push(`Provider Session inspection failed: ${session.error}`);
  const body = {
    acceptance: {
      criteria: work.acceptance.criteria.map((criterion) => ({
        description: criterion.description,
        id: criterion.id,
        required: criterion.required
      }))
    },
    commands: {
      items: boundedCommands.map((item, sequence) => ({ ...item, sequence: sequence + 1 })),
      omitted: Math.max(0, allCommands.length - boundedCommands.length),
      total: allCommands.length
    },
    contract: COMPLETION_CARD_CONTRACT,
    final_message: latestFinalMessage(events, run),
    git,
    human_review: humanReviewResolution(events, runs),
    issue: {
      goal: issue.description.trim() || issue.title,
      id: issue.id,
      project_id: issue.project_id,
      status: issue.status,
      title: issue.title,
      updated_at: issue.updated_at
    },
    provider_outcome: providerOutcome(events, run),
    run: {
      attempt: run.attempt,
      ended_at: run.ended_at,
      id: run.id,
      provider: run.provider,
      provider_session_id: run.provider_session_id,
      provider_turn_id: run.provider_turn_id,
      started_at: run.started_at,
      status: run.status
    },
    session,
    warnings
  };
  const facts = { ...body, prior_evidence: await buildPriorExecutionEvidence(db, body) };
  const fingerprint = createHash("sha256").update(stableJson(facts)).digest("hex");
  return { ...facts, fingerprint, generated_at: (options.now ?? new Date()).toISOString() };
}

export function recordIssueCompletionCard(db: RunnerDatabase, card: CompletionCard, source: string): void {
  const existing = listIssueEvents(db, card.issue.id, {
    limit: 20,
    types: [COMPLETION_CARD_EVENT_TYPE]
  }).some((event) => objectValue(parseJson(event.payload)).fingerprint === card.fingerprint);
  if (existing) return;
  recordIssueEvent(db, card.issue.id, COMPLETION_CARD_EVENT_TYPE, {
    card,
    fingerprint: card.fingerprint,
    source
  });
}

export function readCurrentIssueCompletionCard(db: RunnerDatabase, issueID: number): CompletionCard | null {
  const issue = getIssue(db, issueID);
  const run = listIssueRuns(db, issueID).at(-1);
  if (!issue || !run || run.ended_at === "") return null;
  const events = listIssueEvents(db, issueID, { limit: 20, types: [COMPLETION_CARD_EVENT_TYPE] });
  for (const event of [...events].reverse()) {
    const card = objectValue(parseJson(objectValue(parseJson(event.payload)).card));
    try {
      assertCompletionCardIntegrity(card);
      if (card.issue.id !== issue.id || card.issue.updated_at !== issue.updated_at || card.run.id !== run.id) continue;
      return card;
    } catch {
      continue;
    }
  }
  return null;
}

export function assertCompletionCardIntegrity(value: unknown): asserts value is CompletionCard {
  const card = objectValue(value);
  const issue = objectValue(card.issue);
  const run = objectValue(card.run);
  const session = objectValue(card.session);
  const commands = objectValue(card.commands);
  if (card.contract !== COMPLETION_CARD_CONTRACT) throw new Error("unsupported completion card contract");
  if (!Number.isSafeInteger(issue.id) || Number(issue.id) <= 0) throw new Error("completion card issue.id is invalid");
  if (cleanString(issue.project_id) === "") throw new Error("completion card issue.project_id is required");
  if (cleanString(run.id) === "" || !Number.isFinite(Date.parse(cleanString(run.ended_at)))) {
    throw new Error("completion card requires an ended Run");
  }
  if (!Array.isArray(commands.items) || !Number.isSafeInteger(commands.total) || !Number.isSafeInteger(commands.omitted)) {
    throw new Error("completion card commands summary is invalid");
  }
  if (Object.keys(session).length > 0) {
    if (!Array.isArray(session.latest_turn_items) || !Number.isSafeInteger(session.turn_count)) {
      throw new Error("completion card session summary is invalid");
    }
  }
  const fingerprint = cleanString(card.fingerprint);
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("completion card fingerprint is invalid");
  if (!Number.isFinite(Date.parse(cleanString(card.generated_at)))) throw new Error("completion card generated_at is invalid");
  const computedFingerprint = completionCardFingerprint(card);
  if (computedFingerprint !== fingerprint) {
    throw new Error(`completion card fingerprint does not match its facts (${fingerprint} != ${computedFingerprint})`);
  }
}

export function completionCardFingerprint(value: Record<string, unknown> | CompletionCard): string {
  const { fingerprint: _fingerprint, generated_at: _generatedAt, ...body } = value;
  return createHash("sha256").update(stableJson(body)).digest("hex");
}

export { COMPLETION_CARD_CONTRACT } from "./completionCardModel.ts";
export { COMPLETION_CARD_EVENT_TYPE } from "./completionCardModel.ts";
export { COMPLETION_GIT_OBSERVATION_CONTRACT } from "./completionCardModel.ts";
export { COMPLETION_GIT_OBSERVATION_EVENT_TYPE } from "./completionCardModel.ts";
export { TERMINAL_COMMAND_OBSERVATION_CONTRACT } from "./completionCardModel.ts";
export type { CompletionCardCommand } from "./completionCardModel.ts";
export type { CompletionCard } from "./completionCardModel.ts";
export { recordCompletionGitObservation } from "./completionCardGit.ts";
