import { getAgentSession, upsertAgentSession } from "../db/repositories/agentSessions.ts";
import {
  hydrateStoredIssueLogPayload,
  recordIssueEvent,
  recordIssueLogEvent,
  RUNTIME_EVIDENCE_CORRELATION_CONTRACT,
  type RuntimeEvidenceCorrelation
} from "../db/repositories/issueEvents.ts";
import { ensureOpenIssueRun, updateIssueRuntime } from "../db/repositories/issueRuns.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { issueTimestamp } from "../db/repositories/issueCreate.ts";
import { projectNormalizedRunEvent } from "../db/repositories/runAttemptEvents.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { AppEvent, EventBus } from "../events/bus.ts";
import { normalizedRunEvent } from "../providers/runEvents.ts";
import type {
  ExecutorProvider,
  ExecutorProviderId,
  ProviderEvent,
  ProviderRecoveryInput,
  ProviderRunInput,
  ProviderRunResult,
  SessionRef
} from "../providers/types.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { captureRuntimeEvidenceFromIssueLog } from "../domain/evidence/completionGate.ts";
import { makeRunAttemptID } from "../domain/run/contracts.ts";
import { makeDomainID } from "../xuanwu/coreDomainContracts.ts";
import { syncProviderApprovalRequest } from "./providerApprovalRequests.ts";
import { signalProviderTerminalEvent } from "./providerTerminalSignals.ts";
import { createIssueLogPersistence, type IssueLogMode } from "./issueLogPersistence.ts";
import { parseProviderOutcomeMarker, reconcileProviderOutcome } from "./providerOutcome.ts";

export type RunnerIssueExecutionInput = Omit<ProviderRunInput, "onEvent"> & {
  agentProfileId?: string;
  agentRole?: string;
  bus?: Pick<EventBus, "publish">;
  capabilitySummary?: string;
  database?: RunnerDatabase;
  onLog?: ProviderRunInput["onEvent"];
  onProjectSlotReleased?: (projectID: string) => void;
  onRunComplete?: (output: ProviderRuntimeComplete) => void;
  onRunStart?: (input: ProviderRuntimeStart) => void;
  onRuntimeEvent?: ProviderRunInput["onEvent"];
  selectionReason?: string;
};
export type RunnerIssueRecoveryInput = RunnerIssueExecutionInput & { session: SessionRef };

export type ProviderRuntimeStart = {
  issueId: number;
  metadata: { cwd: string };
  projectId: string;
  provider: string;
};

export type ProviderRuntimeComplete = Omit<ProviderRuntimeStart, "metadata"> & ProviderRunResult;

export async function runIssueWithProvider(
  provider: Pick<ExecutorProvider, "capabilities" | "id" | "run">,
  input: RunnerIssueExecutionInput
): Promise<ProviderRunResult> {
  if (!provider.capabilities.includes("issue_execution")) {
    throw new Error('executor provider missing capability "issue_execution"');
  }
  const providerID = provider.id;
  const activeRun = input.database ? ensureOpenIssueRun(input.database, input.issueId) : undefined;
  input.onRunStart?.({
    provider: providerID,
    issueId: input.issueId,
    projectId: input.projectId,
    metadata: { cwd: input.cwd }
  });
  const activeRunID = activeRun?.id ?? openIssueRunID(input.database, input.issueId);
  if (input.database) {
    updateIssueRuntime(input.database, input.issueId, {
      agent_profile_id: input.agentProfileId,
      capability_summary: input.capabilitySummary,
      issue_run_id: activeRunID,
      metadata: runtimeMetadata(input, { source: "provider_start" }),
      provider: providerID,
      selection_reason: input.selectionReason
    });
  }
  const eventSink = providerEventSink(input, activeRunID, activeRun?.attempt ?? 0);
  let result: ProviderRunResult;
  try {
    result = await provider.run(providerInput(input, eventSink.push));
  } catch (error) {
    if (!eventSink.hasFailure()) eventSink.push(providerRunErrorEvent(providerID, error));
    throw error;
  } finally {
    await eventSink.flush();
    resetDebugIssueLogMode(input, eventSink.mode, providerID);
  }
  persistRuntimeResult(input, providerID, result, activeRunID);
  input.onRunComplete?.({
    provider: providerID,
    issueId: input.issueId,
    projectId: input.projectId,
    runId: result.runId,
    session: result.session
  });
  return result;
}

export async function recoverIssueWithProvider(
  provider: Pick<ExecutorProvider, "capabilities" | "id" | "recover">,
  input: RunnerIssueRecoveryInput
): Promise<ProviderRunResult> {
  if (!provider.capabilities.includes("resume_session") || !provider.recover) {
    throw new Error('executor provider missing capability "resume_session"');
  }
  const providerID = provider.id;
  const activeRun = input.database ? ensureOpenIssueRun(input.database, input.issueId) : undefined;
  const activeRunID = activeRun?.id ?? openIssueRunID(input.database, input.issueId);
  if (input.database) {
    updateIssueRuntime(input.database, input.issueId, {
      agent_profile_id: input.agentProfileId,
      capability_summary: input.capabilitySummary,
      issue_run_id: activeRunID,
      metadata: runtimeMetadata(input, { source: "provider_recovery_start" }),
      provider: providerID,
      provider_session_id: input.session.sessionId,
      provider_turn_id: input.session.turnId ?? "",
      selection_reason: input.selectionReason
    });
  }
  const eventSink = providerEventSink(input, activeRunID, activeRun?.attempt ?? 0);
  let result: ProviderRunResult;
  try {
    result = await provider.recover(providerRecoveryInput(input, eventSink.push));
  } catch (error) {
    if (!eventSink.hasFailure()) eventSink.push(providerRunErrorEvent(providerID, error));
    throw error;
  } finally {
    await eventSink.flush();
    resetDebugIssueLogMode(input, eventSink.mode, providerID);
  }
  persistRuntimeResult(input, providerID, result, activeRunID);
  return result;
}

function providerEventSink(input: RunnerIssueExecutionInput, activeRunID: string, activeAttempt: number) {
  const pendingEvidence = new Set<Promise<void>>();
  const mode = issueLogMode(input);
  const persistence = createIssueLogPersistence((event) => {
    const pending = persistRuntimeEvent(input, event, activeRunID, activeAttempt);
    if (!pending) return;
    pendingEvidence.add(pending);
    void pending.finally(() => pendingEvidence.delete(pending));
  }, { mode });
  let failure = false;
  let sessionObserved = false;
  return {
    async flush() {
      persistence.flush();
      await Promise.all([...pendingEvidence]);
    },
    mode,
    hasFailure: () => failure,
    push(event: ProviderEvent) {
      if (event.runEvent?.kind === "error") failure = true;
      input.onLog?.(event);
      const persistSession = Boolean(event.session) &&
        (!sessionObserved || eventSessionStatus(event) !== "");
      processRuntimeEvent(input, event, activeRunID, persistSession);
      if (event.session) sessionObserved = true;
      persistRunnerOutcomeMarker(input, event, activeRunID);
      persistence.push(event);
      if (successfulTerminalEvent(event) && input.database) {
        const pending = reconcileProviderOutcome({
          bus: input.bus,
          database: input.database,
          issueID: input.issueId,
          issueRunID: activeRunID,
          providerID: event.provider
        }).then((issue) => {
          if (issue && issue.status !== "in_progress") input.onProjectSlotReleased?.(issue.project_id);
        }).catch((error) => {
          input.onLog?.({
            error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
            provider: event.provider,
            raw: { method: "runtime/provider_outcome_reconcile_error" },
            status: "failed",
            type: "error"
          });
        });
        pendingEvidence.add(pending);
        void pending.finally(() => pendingEvidence.delete(pending));
      }
      input.onRuntimeEvent?.(event);
    }
  };
}

function persistRunnerOutcomeMarker(
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

function resetDebugIssueLogMode(
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

function issueLogMode(input: RunnerIssueExecutionInput): IssueLogMode {
  if (!input.database) return "normal";
  return getIssue(input.database, input.issueId)?.issue_log_mode ?? "normal";
}

function processRuntimeEvent(
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

function providerInput(input: RunnerIssueExecutionInput, onEvent: ProviderRunInput["onEvent"]): ProviderRunInput {
  return {
    issueId: input.issueId,
    projectId: input.projectId,
    cwd: input.cwd,
    images: input.images,
    prompt: input.prompt,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    serviceTier: input.serviceTier,
    serviceTierSource: input.serviceTierSource,
    approvalPolicy: input.approvalPolicy,
    sandbox: input.sandbox,
    onEvent
  };
}

function providerRecoveryInput(
  input: RunnerIssueRecoveryInput,
  onEvent: ProviderRunInput["onEvent"]
): ProviderRecoveryInput {
  return { ...providerInput(input, onEvent), session: input.session };
}

function persistRuntimeResult(
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

function persistRuntimeEvent(
  input: RunnerIssueExecutionInput,
  event: ProviderEvent,
  activeRunID: string,
  activeAttempt: number
): Promise<void> | undefined {
  if (!input.database) return;
  const persisted = recordIssueLogEvent(
    input.database,
    input.issueId,
    event,
    runtimeEvidenceCorrelation(event, activeRunID, activeAttempt)
  );
  publishIssueLog(input, event, persisted);
  projectNormalizedRunEvent(input.database, activeRunID, event.runEvent, persisted.id);
  if (event.raw?.method !== "item/completed") return;
  const evidenceEvent = {
    ...persisted,
    payload: hydrateStoredIssueLogPayload(input.database, persisted.payload)
  };
  return captureRuntimeEvidenceFromIssueLog(
    input.database,
    input.issueId,
    evidenceEvent,
    activeRunID
  ).then(() => undefined).catch((error) => {
    input.onLog?.({
      error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      provider: event.provider,
      raw: { method: "runtime/evidence_capture_error" },
      status: "failed",
      type: "error"
    });
  });
}

function runtimeEvidenceCorrelation(
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

function resultSessionStatus(db: RunnerDatabase, provider: string, session: SessionRef): string {
  const sessionID = session.sessionId.trim();
  if (sessionID === "") return "";
  const existing = getAgentSession(db, `${provider}:${sessionID}`);
  return existing?.status ? "" : "running";
}

function eventSessionStatus(event: ProviderEvent): string {
  const method = event.raw?.method ?? "";
  const terminal = event.runEvent?.terminal === true ? event.runEvent.outcome : "";
  if (terminal === "succeeded") return event.status || "completed";
  if (terminal === "interrupted" || terminal === "cancelled") return "interrupted";
  if (terminal === "failed") return event.status || "failed";
  if (event.type === "turn_started" || method === "turn/started") return event.status || "running";
  if (method === "thread/status/changed") return event.status || "";
  if (method === "turn/completed") return event.status || "completed";
  if (event.type === "done") return event.status || "completed";
  if (event.type === "error") return event.status || "failed";
  return "";
}

function successfulTerminalEvent(event: ProviderEvent): boolean {
  if (event.runEvent?.terminal === true) return event.runEvent.outcome === "succeeded";
  const method = event.raw?.method ?? "";
  const status = (event.status ?? "").trim().toLowerCase();
  if (method === "turn/completed") return status === "" || status === "completed" || status === "succeeded";
  return event.type === "done" && !["failed", "error", "interrupted", "cancelled"].includes(status);
}

function publishIssueLog(
  input: RunnerIssueExecutionInput,
  event: ProviderEvent,
  persisted: { created_at: string; id: number; payload: string; type: string }
): void {
  input.bus?.publish(compactAppEvent({
    id: persisted.id,
    type: persisted.type,
    issueId: input.issueId,
    projectId: input.projectId,
    provider: event.provider,
    threadId: event.session?.sessionId,
    turnId: event.session?.turnId,
    agent_event_type: event.type,
    raw_method: event.raw?.method,
    raw_payload: rawPayloadText(event.raw?.payload),
    command: event.command,
    path: event.path,
    status: event.status,
    text: event.text,
    error: event.error,
    payload: persisted.payload,
    created_at: persisted.created_at
  }));
}

function compactAppEvent(event: AppEvent): AppEvent {
  return Object.fromEntries(
    Object.entries(event).filter(([, value]) => value !== undefined && value !== "")
  ) as AppEvent;
}

function rawPayloadText(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function runtimeMetadata(
  input: RunnerIssueExecutionInput,
  metadata: Record<string, string>
): Record<string, string> {
  const serviceTier = cleanString(input.serviceTier);
  if (serviceTier === "") return metadata;
  return {
    ...metadata,
    service_tier: serviceTier,
    service_tier_source: cleanString(input.serviceTierSource) || "unknown"
  };
}

type PersistRuntimeInput = {
  db: RunnerDatabase;
  input: RunnerIssueExecutionInput;
  metadata: Record<string, string>;
  provider: string;
  session: SessionRef;
  status: string;
  issueRunId: string;
};

function persistRuntime(args: PersistRuntimeInput): void {
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

function openIssueRunID(db: RunnerDatabase | undefined, issueID: number): string {
  if (!db) return "";
  return db.sqlite.query<{ id: string }, [number]>(
    "select id from issue_runs where issue_id=? and ended_at='' order by attempt desc limit 1"
  ).get(issueID)?.id ?? "";
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function providerRunErrorEvent(provider: ExecutorProviderId, error: unknown): ProviderEvent {
  const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
  return {
    error: message,
    provider,
    raw: { method: "provider/run_error", payload: message },
    runEvent: normalizedRunEvent({ kind: "error", method: "provider/run_error", outcome: "failed", provider }),
    status: "failed",
    type: "error"
  };
}
