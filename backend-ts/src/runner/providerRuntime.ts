import { getAgentSession, upsertAgentSession } from "../db/repositories/agentSessions.ts";
import {
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
import {
  isProviderInterruptedError,
  type ExecutorProvider,
  type ExecutorProviderId,
  type ProviderEvent,
  type ProviderRecoveryInput,
  type ProviderRunInput,
  type ProviderRunResult,
  type SessionRef
} from "../providers/types.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { makeRunAttemptID } from "../domain/run/contracts.ts";
import { makeDomainID } from "../xuanwu/coreDomainContracts.ts";
import { syncProviderApprovalRequest } from "./providerApprovalRequests.ts";
import { signalProviderTerminalEvent } from "./providerTerminalSignals.ts";
import { createIssueLogPersistence, type IssueLogMode } from "./issueLogPersistence.ts";
import { parseProviderOutcomeMarker, reconcileProviderOutcome } from "./providerOutcome.ts";
import { ExecutionPolicyError, type ExecutionPolicyRequest, type ProviderPolicyContext } from "../providers/core/policyContracts.ts";
import type { ProviderTransport } from "../providers/core/manifest.ts";
import { translateLegacyExecutionPolicy } from "../providers/core/legacyExecutionPolicy.ts";
import { resolveExecutionPolicy } from "../providers/core/policyResolution.ts";

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
  executionPolicyRequest?: ExecutionPolicyRequest;
  executionPolicyCapabilityRevision?: string;
  executionPolicyResolutionSource?: "default" | "legacy" | "profile" | "project" | "session" | "explicit";
  executionPolicyProviderVersion?: string;
  executionPolicyTransport?: ProviderTransport;
  executionSource?: ProviderPolicyContext["source"];
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
  provider: Pick<ExecutorProvider, "capabilities" | "id" | "manifest" | "policyAdapter" | "run" | "runtimeStatus">,
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
  const resolvedInput = await resolveRuntimePolicyOrPersist(
    provider,
    input,
    activeRunID,
    activeRun?.attempt ?? 0,
    input.executionSource ?? "local-user"
  );
  if (resolvedInput.database) {
    updateIssueRuntime(resolvedInput.database, resolvedInput.issueId, {
      agent_profile_id: resolvedInput.agentProfileId,
      capability_summary: resolvedInput.capabilitySummary,
      issue_run_id: activeRunID,
      metadata: runtimeMetadata(resolvedInput, { source: "provider_start" }),
      provider: providerID,
      selection_reason: resolvedInput.selectionReason
    });
  }
  const eventSink = providerEventSink(resolvedInput, activeRunID, activeRun?.attempt ?? 0);
  let result: ProviderRunResult;
  try {
    result = await provider.run(providerInput(resolvedInput, eventSink.push));
  } catch (error) {
    if (!isProviderInterruptedError(error) && !eventSink.hasFailure()) {
      eventSink.push(providerRunErrorEvent(providerID, error));
    }
    throw error;
  } finally {
    await eventSink.flush();
    resetDebugIssueLogMode(resolvedInput, eventSink.mode, providerID);
  }
  persistRuntimeResult(resolvedInput, providerID, result, activeRunID);
  resolvedInput.onRunComplete?.({
    provider: providerID,
    issueId: input.issueId,
    projectId: input.projectId,
    runId: result.runId,
    session: result.session
  });
  return result;
}

export async function recoverIssueWithProvider(
  provider: Pick<ExecutorProvider, "capabilities" | "id" | "manifest" | "policyAdapter" | "recover" | "runtimeStatus">,
  input: RunnerIssueRecoveryInput
): Promise<ProviderRunResult> {
  if (!provider.capabilities.includes("resume_session") || !provider.recover) {
    throw new Error('executor provider missing capability "resume_session"');
  }
  const providerID = provider.id;
  const activeRun = input.database ? ensureOpenIssueRun(input.database, input.issueId) : undefined;
  const activeRunID = activeRun?.id ?? openIssueRunID(input.database, input.issueId);
  const resolvedInput = await resolveRuntimePolicyOrPersist(
    provider,
    input,
    activeRunID,
    activeRun?.attempt ?? 0,
    "recovery"
  ) as RunnerIssueRecoveryInput;
  if (resolvedInput.database) {
    updateIssueRuntime(resolvedInput.database, resolvedInput.issueId, {
      agent_profile_id: resolvedInput.agentProfileId,
      capability_summary: resolvedInput.capabilitySummary,
      issue_run_id: activeRunID,
      metadata: runtimeMetadata(resolvedInput, { source: "provider_recovery_start" }),
      provider: providerID,
      provider_session_id: resolvedInput.session.sessionId,
      provider_turn_id: resolvedInput.session.turnId ?? "",
      selection_reason: resolvedInput.selectionReason
    });
  }
  const eventSink = providerEventSink(resolvedInput, activeRunID, activeRun?.attempt ?? 0);
  let result: ProviderRunResult;
  try {
    result = await provider.recover(providerRecoveryInput(resolvedInput, eventSink.push));
  } catch (error) {
    if (!isProviderInterruptedError(error) && !eventSink.hasFailure()) {
      eventSink.push(providerRunErrorEvent(providerID, error));
    }
    throw error;
  } finally {
    await eventSink.flush();
    resetDebugIssueLogMode(resolvedInput, eventSink.mode, providerID);
  }
  persistRuntimeResult(resolvedInput, providerID, result, activeRunID);
  return result;
}

function providerEventSink(input: RunnerIssueExecutionInput, activeRunID: string, activeAttempt: number) {
  const pendingReconciliations = new Set<Promise<void>>();
  const mode = issueLogMode(input);
  const persistence = createIssueLogPersistence((event) => {
    persistRuntimeEvent(input, event, activeRunID, activeAttempt);
  }, { mode });
  let failure = false;
  let sessionObserved = false;
  return {
    async flush() {
      persistence.flush();
      await Promise.all([...pendingReconciliations]);
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
      const terminalOutcome = providerTerminalOutcome(event);
      if (terminalOutcome && input.database) {
        const pending = reconcileProviderOutcome({
          bus: input.bus,
          database: input.database,
          issueID: input.issueId,
          issueRunID: activeRunID,
          providerID: event.provider,
          reportedOutcome: parseProviderOutcomeMarker(event.text) ?? terminalOutcome
        }).then(() => undefined).catch((error) => {
          input.onLog?.({
            error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
            provider: event.provider,
            raw: { method: "runtime/provider_outcome_reconcile_error" },
            status: "failed",
            type: "error"
          });
        });
        pendingReconciliations.add(pending);
        void pending.finally(() => pendingReconciliations.delete(pending));
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
    policy: input.policy,
    onEvent
  };
}

function withResolvedExecutionPolicy(
  provider: Pick<ExecutorProvider, "id" | "manifest" | "policyAdapter" | "runtimeStatus">,
  input: RunnerIssueExecutionInput,
  activeRunID: string,
  source: ProviderPolicyContext["source"]
): RunnerIssueExecutionInput {
  if (input.policy) return input;
  const capabilities = provider.manifest?.executionPolicy;
  if (!capabilities || !provider.policyAdapter) return input;
  const translated = input.executionPolicyRequest
    ? { policy: input.executionPolicyRequest, warnings: [] as string[] }
    : translateLegacyExecutionPolicy({
      scope: "project",
      sandbox: input.sandbox,
      approvalPolicy: input.approvalPolicy
    });
  if (!translated.policy) return input;
  const runtime = provider.runtimeStatus?.();
  const transport = selectedProviderTransport(provider);
  const providerVersion = runtime?.version ?? "";
  const policy = resolveExecutionPolicy(translated.policy, {
    cwd: input.cwd,
    invocationRef: activeRunID || `issue:${input.issueId}:pending`,
    projectId: input.projectId,
    providerId: provider.manifest!.id,
    providerVersion,
    source,
    transport
  }, capabilities, provider.policyAdapter);
  if (translated.warnings.length > 0) {
    policy.warnings = [...new Set([...policy.warnings, ...translated.warnings])];
  }
  return {
    ...input,
    executionPolicyRequest: translated.policy,
    executionPolicyCapabilityRevision: capabilities.contract,
    executionPolicyProviderVersion: providerVersion,
    executionPolicyTransport: transport,
    policy
  };
}

async function resolveRuntimePolicyOrPersist(
  provider: Pick<ExecutorProvider, "id" | "manifest" | "policyAdapter" | "runtimeStatus">,
  input: RunnerIssueExecutionInput,
  activeRunID: string,
  activeAttempt: number,
  source: ProviderPolicyContext["source"]
): Promise<RunnerIssueExecutionInput> {
  try {
    return withResolvedExecutionPolicy(provider, input, activeRunID, source);
  } catch (error) {
    const code = error instanceof ExecutionPolicyError ? error.code : "policy_resolution_failed";
    const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
    if (input.database) {
      updateIssueRuntime(input.database, input.issueId, {
        agent_profile_id: input.agentProfileId,
        capability_summary: input.capabilitySummary,
        issue_run_id: activeRunID,
        metadata: {
          source: source === "recovery" ? "provider_recovery_policy_error" : "provider_policy_error",
          configuration_error: { code, message },
          requested_execution_policy: input.executionPolicyRequest ?? null,
          provider: provider.id,
          provider_version: input.executionPolicyProviderVersion ?? provider.runtimeStatus?.().version ?? "",
          transport: input.executionPolicyTransport ?? selectedProviderTransport(provider),
          resolution_source: input.executionPolicyResolutionSource ?? (input.executionPolicyRequest ? "explicit" : "legacy")
        },
        provider: provider.id,
        selection_reason: input.selectionReason
      });
    }
    const eventSink = providerEventSink(input, activeRunID, activeAttempt);
    eventSink.push(policyResolutionErrorEvent(provider.id, code, message));
    await eventSink.flush();
    resetDebugIssueLogMode(input, eventSink.mode, provider.id);
    throw error;
  }
}

function selectedProviderTransport(
  provider: Pick<ExecutorProvider, "manifest" | "runtimeStatus">
): ProviderTransport {
  const transports = provider.manifest?.transports ?? [];
  const mode = provider.runtimeStatus?.().mode?.trim() ?? "";
  const mapped = mode === "cli-fallback" ? "stdio-json" : mode;
  return (transports.includes(mapped as ProviderTransport) ? mapped : transports[0] ?? "sdk") as ProviderTransport;
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
): void {
  if (!input.database) return;
  const persisted = recordIssueLogEvent(
    input.database,
    input.issueId,
    event,
    runtimeEvidenceCorrelation(event, activeRunID, activeAttempt)
  );
  publishIssueLog(input, event, persisted);
  projectNormalizedRunEvent(input.database, activeRunID, event.runEvent, persisted.id);
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

function providerTerminalOutcome(event: ProviderEvent): ReturnType<typeof parseProviderOutcomeMarker> {
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
): Record<string, unknown> {
  const serviceTier = cleanString(input.serviceTier);
  return {
    ...metadata,
    resolved_settings: {
      approval_policy: cleanString(input.approvalPolicy),
      model: cleanString(input.model),
      reasoning_effort: cleanString(input.reasoningEffort),
      sandbox: cleanString(input.sandbox),
      service_tier: serviceTier,
      service_tier_source: cleanString(input.serviceTierSource) || (serviceTier ? "unknown" : "standard")
    },
    ...(input.policy ? {
      requested_execution_policy: input.policy.requested,
      resolved_execution_policy: {
        contract: input.policy.contract,
        effects: input.policy.effects,
        isolation: input.policy.isolation,
        native_summary: input.policy.nativeSummary,
        proof: input.policy.proof
      },
      provider_policy_capability_revision: input.executionPolicyCapabilityRevision ?? "",
      provider_version: input.executionPolicyProviderVersion ?? "",
      transport: input.executionPolicyTransport ?? "",
      resolution_source: input.executionPolicyResolutionSource ?? (input.executionPolicyRequest ? "explicit" : "legacy"),
      classifier_authority: input.policy.proof.some((proof) => proof.kind === "adapter-callback") ? "host" : "provider",
      proof_strength: [...new Set(input.policy.proof.map((proof) => proof.strength))],
      warnings: input.policy.warnings
    } : {}),
    ...(serviceTier === "" ? {} : {
      service_tier: serviceTier,
      service_tier_source: cleanString(input.serviceTierSource) || "unknown"
    })
  };
}

type PersistRuntimeInput = {
  db: RunnerDatabase;
  input: RunnerIssueExecutionInput;
  metadata: Record<string, unknown>;
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

function policyResolutionErrorEvent(provider: ExecutorProviderId, code: string, message: string): ProviderEvent {
  return {
    error: message,
    provider,
    raw: { method: "execution-policy/resolve_error", payload: { code, message } },
    runEvent: normalizedRunEvent({
      kind: "error",
      method: "execution-policy/resolve_error",
      outcome: "failed",
      provider
    }),
    status: "configuration_error",
    type: "error"
  };
}
