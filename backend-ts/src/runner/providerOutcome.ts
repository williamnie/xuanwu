import type { RunnerDatabase } from "../db/database.ts";
import { listIssueEvents, recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { getIssue, type Issue } from "../db/repositories/issues.ts";
import { getProject } from "../db/repositories/projects.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import type { EventBus } from "../events/bus.ts";
import {
  applyIssueStateRepair,
  diagnoseIssueState,
  recommendedRepairPayload
} from "../pi/issueStateManager.ts";
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
  const reported = providerReportedOutcome(input.database, current.id, input.issueRunID);
  const now = input.now ?? new Date();
  if (reported.outcome !== "unknown") {
    closeReportedTerminalRun(input.database, input.issueRunID, reported, now.toISOString());
    updateIssue(input.database, current.id, { error: "", status: "pending_verification" });
  } else {
    const diagnostic = diagnoseIssueState(input.database, {
      includeDoneIssues: true,
      issueIDs: [current.id],
      now
    }).diagnostics.find((item) => item.code === "in_progress_session_ended");
    const repair = diagnostic?.recommended_actions.find((action) =>
      action.operation === "patch_status" && action.patch?.status === "pending_verification"
    );
    if (!diagnostic || !repair) return current;
    applyIssueStateRepair(input.database, recommendedRepairPayload(input.database, current.id, {
      diagnosisCode: diagnostic.code,
      includeDoneIssues: true,
      now,
      operation: repair.operation
    }));
  }
  const terminalRun = getIssue(input.database, current.id)?.latest_run;
  const project = getProject(input.database, current.project_id);
  if (terminalRun?.id === input.issueRunID && project) {
    recordCompletionGitObservation(input.database, {
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
  recordIssueEvent(input.database, current.id, "issue.pi_acceptance_requested.v1", {
    command_observation_contract: TERMINAL_COMMAND_OBSERVATION_CONTRACT,
    issue_run_id: input.issueRunID,
    provider_run_id: input.providerRunID ?? "",
    provider_outcome: reported.outcome,
    provider_reason: reported.reason,
    reason: "provider reached terminal state; issue-scoped PI semantic acceptance required"
  });
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
  const status = reported.outcome === "completed" ? "done" : "failed";
  db.sqlite.run(
    `update issue_runs set status=?, ended_at=case when ended_at='' then ? else ended_at end,
      exit_reason=case when exit_reason='' then ? else exit_reason end,
      error=case when error='' then ? else error end where id=?`,
    [status, endedAt, `provider_reported_${reported.outcome}`, reported.reason, issueRunID]
  );
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
