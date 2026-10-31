import { recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { issueTimestamp } from "../db/repositories/issueCreate.ts";
import { type ExecutorProviderId, type ProviderEvent } from "../providers/types.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { syncProviderApprovalRequest } from "./providerApprovalRequests.ts";
import { signalProviderTerminalEvent } from "./providerTerminalSignals.ts";
import { type IssueLogMode } from "./issueLogPersistence.ts";
import { parseProviderOutcomeMarker } from "./providerOutcome.ts";
import type { RunnerIssueExecutionInput } from "./providerRuntime.model.ts";
import { persistRuntime, eventSessionStatus } from "./providerRuntime.persistence.ts";
import { runtimeMetadata } from "./providerRuntime.publication.ts";

export function persistRunnerOutcomeMarker(
  input: RunnerIssueExecutionInput,
  event: ProviderEvent,
  activeRunID: string
): void {
  if (!input.database) return;
  const outcome = parseProviderOutcomeMarker(event.text);
  if (!outcome) return;
  recordIssueEvent(input.database, input.issueId, "issue.runner_outcome", {
    issue_run_id: activeRunID,
    outcome: outcome.outcome,
    provider: event.provider,
    provider_session_id: event.session?.sessionId ?? "",
    provider_turn_id: event.session?.turnId ?? "",
    reason: outcome.reason
  });
}

export function resetDebugIssueLogMode(
  input: RunnerIssueExecutionInput,
  mode: IssueLogMode,
  provider: ExecutorProviderId
): void {
  if (!input.database || mode !== "debug") return;
  try {
    const timestamp = issueTimestamp();
    input.database.sqlite.run(
      "update issues set issue_log_mode='normal', updated_at=? where id=? and issue_log_mode='debug'",
      [timestamp, input.issueId]
    );
  } catch (error) {
    input.onLog?.({
      error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      provider,
      raw: { method: "runtime/debug_log_mode_reset_error" },
      status: "failed",
      type: "error"
    });
  }
}

export function issueLogMode(input: RunnerIssueExecutionInput): IssueLogMode {
  if (!input.database) return "normal";
  return getIssue(input.database, input.issueId)?.issue_log_mode ?? "normal";
}

export function processRuntimeEvent(
  input: RunnerIssueExecutionInput,
  event: ProviderEvent,
  activeRunID: string,
  persistSession: boolean
): void {
  if (!input.database) return;
  syncProviderApprovalRequest(input, event, activeRunID);
  if (event.session && persistSession) {
    persistRuntime({
      db: input.database, input, provider: event.session.provider, session: event.session,
      status: eventSessionStatus(event),
      metadata: runtimeMetadata(input, { source: "provider_event" }),
      issueRunId: activeRunID
    });
  }
  signalProviderTerminalEvent({
    activeRunID,
    database: input.database,
    event,
    issueID: input.issueId,
    projectID: input.projectId
  });
}
