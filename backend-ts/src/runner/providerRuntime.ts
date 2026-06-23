import { getAgentSession, upsertAgentSession } from "../db/repositories/agentSessions.ts";
import { recordIssueLogEvent } from "../db/repositories/issueEvents.ts";
import { ensureOpenIssueRun, updateIssueRuntime } from "../db/repositories/issueRuns.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { AppEvent, EventBus } from "../events/bus.ts";
import type { ExecutorProvider, ProviderEvent, ProviderRunInput, ProviderRunResult, SessionRef } from "../providers/types.ts";
import { syncProviderApprovalRequest } from "./providerApprovalRequests.ts";
import { signalProviderTerminalEvent } from "./providerTerminalSignals.ts";

export type RunnerIssueExecutionInput = Omit<ProviderRunInput, "onEvent"> & {
  agentProfileId?: string;
  agentRole?: string;
  bus?: Pick<EventBus, "publish">;
  capabilitySummary?: string;
  database?: RunnerDatabase;
  onLog?: ProviderRunInput["onEvent"];
  onRunComplete?: (output: ProviderRuntimeComplete) => void;
  onRunStart?: (input: ProviderRuntimeStart) => void;
  onRuntimeEvent?: ProviderRunInput["onEvent"];
  selectionReason?: string;
};

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
  input.database && ensureOpenIssueRun(input.database, input.issueId);
  input.onRunStart?.({
    provider: providerID,
    issueId: input.issueId,
    projectId: input.projectId,
    metadata: { cwd: input.cwd }
  });
  const activeRunID = openIssueRunID(input.database, input.issueId);
  const result = await provider.run(providerInput(input, providerEventSink(input, activeRunID)));
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

function providerEventSink(input: RunnerIssueExecutionInput, activeRunID: string): ProviderRunInput["onEvent"] {
  return (event) => {
    input.onLog?.(event);
    persistRuntimeEvent(input, event, activeRunID);
    input.onRuntimeEvent?.(event);
  };
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

function persistRuntimeResult(input: RunnerIssueExecutionInput, provider: string, result: ProviderRunResult, activeRunID: string): void {
  if (!input.database || !result.session) return;
  persistRuntime({
    db: input.database, input, provider, session: result.session,
    status: resultSessionStatus(input.database, provider, result.session), metadata: runtimeMetadata(input, { run_id: result.runId }),
    issueRunId: activeRunID || openIssueRunID(input.database, input.issueId)
  });
}

function persistRuntimeEvent(input: RunnerIssueExecutionInput, event: ProviderEvent, activeRunID: string): void {
  if (!input.database) return;
  const persisted = recordIssueLogEvent(input.database, input.issueId, event);
  syncProviderApprovalRequest(input, event, activeRunID);
  publishIssueLog(input, event, persisted);
  if (event.session) {
    persistRuntime({
      db: input.database, input, provider: event.session.provider, session: event.session,
      status: eventSessionStatus(event), metadata: runtimeMetadata(input, { source: "provider_event" }),
      issueRunId: activeRunID
    });
  }
  signalProviderTerminalEvent({
    activeRunID,
    database: input.database,
    event,
    issueEventID: persisted.id,
    issueID: input.issueId,
    projectID: input.projectId
  });
}

function resultSessionStatus(db: RunnerDatabase, provider: string, session: SessionRef): string {
  const sessionID = session.sessionId.trim();
  if (sessionID === "") return "";
  const existing = getAgentSession(db, `${provider}:${sessionID}`);
  return existing?.status ? "" : "running";
}

function eventSessionStatus(event: ProviderEvent): string {
  const method = event.raw?.method ?? "";
  if (event.type === "turn_started" || method === "turn/started") return event.status || "running";
  if (method === "thread/status/changed") return event.status || "";
  if (method === "turn/completed") return event.status || "completed";
  if (event.type === "error") return event.status || "failed";
  return "";
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
