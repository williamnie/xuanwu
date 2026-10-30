import { getAgentSession, upsertAgentSession } from "../db/repositories/agentSessions.ts";
import { recordIssueLogEventAsync, RUNTIME_EVIDENCE_CORRELATION_CONTRACT, type RuntimeEvidenceCorrelation } from "../db/repositories/issueEvents.ts";
import { updateIssueRuntime } from "../db/repositories/issueRuns.ts";
import { projectNormalizedRunEvent } from "../db/repositories/runAttemptEvents.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { type ProviderEvent, type ProviderRunResult, type SessionRef } from "../providers/types.ts";
import { makeRunAttemptID } from "../domain/run/contracts.ts";
import { makeDomainID } from "../xuanwu/coreDomainContracts.ts";
import { parseProviderOutcomeMarker } from "./providerOutcome.ts";
import type { RunnerIssueExecutionInput } from "./providerRuntime.model.ts";
import { runtimeMetadata, publishIssueLog } from "./providerRuntime.publication.ts";

export function persistRuntimeResult(
  input: RunnerIssueExecutionInput,
  provider: string,
  result: ProviderRunResult,
  activeRunID: string
): void {
  if (!input.database || !result.session) return;
  persistRuntime({
    db: input.database, input, provider, session: result.session,
    status: resultSessionStatus(input.database, provider, result.session),
    metadata: runtimeMetadata(input, { run_id: result.runId }),
    issueRunId: activeRunID || openIssueRunID(input.database, input.issueId)
  });
}

export async function persistRuntimeEvent(
  input: RunnerIssueExecutionInput,
  event: ProviderEvent,
  activeRunID: string,
  activeAttempt: number
): Promise<void> {
  if (!input.database) return;
  const persisted = await recordIssueLogEventAsync(
    input.database,
    input.issueId,
    event,
    runtimeEvidenceCorrelation(event, activeRunID, activeAttempt)
  );
  publishIssueLog(input, event, persisted);
  projectNormalizedRunEvent(input.database, activeRunID, event.runEvent, persisted.id);
}

export function runtimeEvidenceCorrelation(
  event: ProviderEvent,
  issueRunID: string,
  attempt: number
): RuntimeEvidenceCorrelation | undefined {
  if (!issueRunID || attempt <= 0) return undefined;
  const runID = makeDomainID("run", "issue_runs", issueRunID);
  return {
    attempt_id: makeRunAttemptID(runID, attempt),
    contract: RUNTIME_EVIDENCE_CORRELATION_CONTRACT,
    issue_run_id: issueRunID,
    provider: event.provider,
    provider_session_id: event.session?.sessionId ?? "",
    provider_turn_id: event.session?.turnId ?? "",
    run_id: runID
  };
}

export function resultSessionStatus(db: RunnerDatabase, provider: string, session: SessionRef): string {
  const sessionID = session.sessionId.trim();
  if (sessionID === "") return "";
  const existing = getAgentSession(db, `${provider}:${sessionID}`);
  return existing?.status ? "" : "running";
}

export function eventSessionStatus(event: ProviderEvent): string {
  const method = event.raw?.method ?? "";
  const terminal = event.runEvent?.terminal === true ? event.runEvent.outcome : "";
  if (terminal === "succeeded") return event.status || "completed";
  if (terminal === "interrupted" || terminal === "cancelled") return "interrupted";
  if (terminal === "failed") return event.status || "failed";
  if (event.type === "provider.session_started" || event.runEvent?.kind === "started") {
    return event.status || "running";
  }
  if (event.type === "turn_started" || method === "turn/started") return event.status || "running";
  if (method === "thread/status/changed") return event.status || "";
  if (method === "turn/completed") return event.status || "completed";
  if (event.type === "done") return event.status || "completed";
  if (event.type === "error") return event.status || "failed";
  return "";
}

export function providerTerminalOutcome(event: ProviderEvent): ReturnType<typeof parseProviderOutcomeMarker> {
  if (event.runEvent?.terminal === true) {
    if (event.runEvent.outcome === "succeeded") return { outcome: "completed", reason: "Provider Turn completed" };
    if (event.runEvent.outcome === "failed") return { outcome: "failed", reason: event.error || event.status || "Provider Turn failed" };
    if (event.runEvent.outcome === "cancelled" || event.runEvent.outcome === "interrupted") {
      // Host interrupt lifecycle owns Run/Attempt cancellation and retry state.
      // Reconciling a provider acknowledgement as a failure races the explicit
      // cancel command and can turn a cancelled Run back into failed.
      return null;
    }
  }
  const method = event.raw?.method ?? "";
  const status = (event.status ?? "").trim().toLowerCase();
  if (event.type === "error") return { outcome: "failed", reason: event.error || status || "Provider error" };
  if (method === "turn/completed" || event.type === "done") {
    return ["failed", "error", "interrupted", "cancelled"].includes(status)
      ? { outcome: "failed", reason: event.error || status }
      : { outcome: "completed", reason: "Provider Turn completed" };
  }
  return null;
}

export type PersistRuntimeInput = {
  db: RunnerDatabase;
  input: RunnerIssueExecutionInput;
  metadata: Record<string, unknown>;
  provider: string;
  session: SessionRef;
  status: string;
  issueRunId: string;
};

export function persistRuntime(args: PersistRuntimeInput): void {
  updateIssueRuntime(args.db, args.input.issueId, {
    agent_profile_id: args.input.agentProfileId,
    capability_summary: args.input.capabilitySummary,
    issue_run_id: args.issueRunId,
    metadata: args.metadata,
    provider: args.provider,
    provider_session_id: args.session.sessionId,
    provider_turn_id: args.session.turnId,
    selection_reason: args.input.selectionReason
  });
  if (args.session.sessionId === "") return;
  upsertAgentSession(args.db, {
    agent_role: args.input.agentRole,
    provider: args.provider,
    provider_session_id: args.session.sessionId,
    project_id: args.input.projectId,
    issue_id: args.input.issueId,
    status: args.status,
    raw_ref: { provider_turn_id: args.session.turnId ?? "", ...args.metadata }
  });
}

export function openIssueRunID(db: RunnerDatabase | undefined, issueID: number): string {
  if (!db) return "";
  return db.sqlite.query<{ id: string }, [number]>(
    "select id from issue_runs where issue_id=? and ended_at='' order by attempt desc limit 1"
  ).get(issueID)?.id ?? "";
}
