import type { RunnerDatabase } from "../db/database.ts";
import { listIssueEvents, recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { getIssue, listIssueRuns, type Issue } from "../db/repositories/issues.ts";
import { getProject } from "../db/repositories/projects.ts";
import { restoreOpenHumanReviewAfterTerminalRun } from "../domain/review/humanReview.ts";
import type { EventBus } from "../events/bus.ts";
import type { ExecutorProviderId } from "../providers/types.ts";
import {
  recordCompletionGitObservation,
  TERMINAL_COMMAND_OBSERVATION_CONTRACT
} from "../domain/acceptance/completionCard.ts";

export type ProviderReportedOutcome = {
  outcome: "completed" | "failed" | "needs_user" | "unknown";
  reason: string;
};

export type ReconcileProviderOutcomeInput = {
  bus?: Pick<EventBus, "publish">;
  database: RunnerDatabase;
  issueID: number;
  issueRunID: string;
  now?: Date;
  providerID: ExecutorProviderId;
  providerRunID?: string;
  providerTurnID?: string;
  reportedOutcome?: ProviderReportedOutcome;
};

/**
 * Provider events are the runtime truth for turn completion. The Runner Host
 * owns the mechanical Issue/Run reconciliation so executors never need to call
 * localhost or a lifecycle CLI.
 */
export async function reconcileProviderOutcome(
  input: ReconcileProviderOutcomeInput
): Promise<Issue | null> {
  const current = getIssue(input.database, input.issueID);
  if (!current || current.status !== "in_progress") return current;
  const currentRun = listIssueRuns(input.database, current.id).at(-1);
  if (currentRun?.id !== input.issueRunID || currentRun.ended_at !== "" ||
    (input.providerTurnID && currentRun.provider_turn_id !== input.providerTurnID)) return current;
  const reported = input.reportedOutcome ?? providerReportedOutcome(input.database, current.id, input.issueRunID);
  const now = input.now ?? new Date();
  if (reported.outcome === "unknown") return current;
  const applied = input.database.transaction(() => {
    const latest = listIssueRuns(input.database, current.id).at(-1);
    if (getIssue(input.database, current.id)?.status !== "in_progress" || latest?.id !== input.issueRunID ||
      latest.ended_at !== "" || (input.providerTurnID && latest.provider_turn_id !== input.providerTurnID)) return false;
    closeReportedTerminalRun(input.database, input.issueRunID, reported, now.toISOString());
    input.database.sqlite.run("update issues set auto_retry_next_at='', auto_retry_reason='' where id=?", [current.id]);
    return true;
  }).immediate();
  if (!applied) return getIssue(input.database, current.id);
  // getIssue 是精简投影，不附带 latest_run；终态快照必须读取 canonical Run。
  const terminalRun = listIssueRuns(input.database, current.id).at(-1);
  const project = getProject(input.database, current.project_id);
  if (terminalRun?.id === input.issueRunID && project) {
    await recordCompletionGitObservation(input.database, {
      issue_id: current.id,
      observed_at: now.toISOString(),
      repository: project.cwd,
      run: terminalRun
    });
  }
  // The Host only establishes the terminal Run/state precondition here. A
  // bounded issue-scoped completion card is built after all terminal facts are
  // durable, then PI performs the semantic acceptance. Do not let the legacy
  // regex-based Evidence gate or Verifier carrier decide completion.
  recordPiDecisionRequest(input.database, current.id, {
    issue_run_id: input.issueRunID,
    provider_run_id: input.providerRunID ?? "",
    provider_outcome: reported.outcome,
    provider_reason: reported.reason
  });
  restoreOpenHumanReviewAfterTerminalRun(input.database, current.id, { bus: input.bus });
  const finalized = getIssue(input.database, current.id);
  if (finalized) publishIssueStatus(input, finalized);
  return finalized;
}

function closeReportedTerminalRun(
  db: RunnerDatabase,
  issueRunID: string,
  reported: ProviderReportedOutcome,
  endedAt: string
): void {
  const status = reported.outcome === "completed" ? "succeeded" : "failed";
  db.sqlite.run(
    `update issue_runs set status=?, ended_at=case when ended_at='' then ? else ended_at end,
      exit_reason=case when exit_reason='' then ? else exit_reason end,
      error=case when error='' then ? else error end where id=?`,
    [status, endedAt, `provider_reported_${reported.outcome}`, reported.reason, issueRunID]
  );
  // legacy trigger 只更新首个 Attempt；续跑的终态必须落到当前 Attempt。
  db.sqlite.run(`update run_attempts set status=?, ended_at=?, terminal_reason=?,
    terminal_source_ref=?, revision=revision+1, updated_at=?
    where attempt_id=(select attempt_id from run_attempts where issue_run_id=? order by sequence desc limit 1)
      and status in ('created', 'running')`,
  [status, endedAt, reported.reason, `provider-outcome:${issueRunID}`, endedAt, issueRunID]);
}

function recordPiDecisionRequest(
  db: RunnerDatabase,
  issueID: number,
  payload: {
    issue_run_id: string;
    provider_outcome: ProviderReportedOutcome["outcome"];
    provider_reason: string;
    provider_run_id: string;
  }
): void {
  const exists = listIssueEvents(db, issueID, {
    limit: 100,
    types: ["issue.pi_acceptance_requested.v1"]
  }).some((event) => cleanString(objectValue(parseEventPayload(event.payload)).issue_run_id) === payload.issue_run_id);
  if (exists) return;
  recordIssueEvent(db, issueID, "issue.pi_acceptance_requested.v1", {
    command_observation_contract: TERMINAL_COMMAND_OBSERVATION_CONTRACT,
    ...payload,
    reason: "provider turn reached terminal state; PI must inspect the Session and decide the Issue"
  });
}

export function providerReportedOutcome(
  db: RunnerDatabase,
  issueID: number,
  issueRunID: string
): ProviderReportedOutcome {
  const events = listIssueEvents(db, issueID, { limit: 100 });
  for (const event of [...events].reverse()) {
    const payload = parseEventPayload(event.payload);
    if (event.type === "issue.runner_outcome") {
      if (cleanString(payload.issue_run_id) !== issueRunID) continue;
      return {
        outcome: normalizedOutcome(payload.outcome),
        reason: cleanString(payload.reason)
      };
    }
    if (event.type !== "issue.log") continue;
    const correlation = objectValue(payload.runtime_evidence_correlation);
    if (cleanString(correlation.issue_run_id) !== issueRunID) continue;
    const parsed = parseProviderOutcomeMarker(payload.text);
    if (parsed) return parsed;
  }
  return { outcome: "unknown", reason: "" };
}

export function parseProviderOutcomeMarker(value: unknown): ProviderReportedOutcome | null {
  const text = cleanString(value);
  for (const rawLine of text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")) {
    const line = rawLine.trim();
    const prefix = "RUNNER_OUTCOME:";
    if (!line.toUpperCase().startsWith(prefix)) continue;
    const fields = line.slice(prefix.length).split("|");
    const outcome = normalizedOutcome(fields.shift());
    if (outcome === "unknown") continue;
    return { outcome, reason: cleanString(fields.join("|")) };
  }
  return null;
}

function publishIssueStatus(
  input: Pick<ReconcileProviderOutcomeInput, "bus">,
  issue: Issue
): void {
  input.bus?.publish({
    issueId: issue.id,
    payload: JSON.stringify({ status: issue.status }),
    projectId: issue.project_id,
    type: "issue.status_changed"
  });
}

function parseEventPayload(value: string): Record<string, unknown> {
  try {
    return objectValue(JSON.parse(value) as unknown);
  } catch {
    return {};
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedOutcome(value: unknown): ProviderReportedOutcome["outcome"] {
  const outcome = cleanString(value).toLowerCase();
  return outcome === "completed" || outcome === "failed" || outcome === "needs_user"
    ? outcome
    : "unknown";
}
