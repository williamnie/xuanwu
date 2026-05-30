import { upsertAgentSession } from "../db/repositories/agentSessions.ts";
import { recordIssueLogEvent } from "../db/repositories/issueEvents.ts";
import { ensureOpenIssueRun, updateIssueRuntime } from "../db/repositories/issueRuns.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { ExecutorProvider, ProviderEvent, ProviderRunInput, ProviderRunResult, SessionRef } from "../providers/types.ts";

export type RunnerIssueExecutionInput = Omit<ProviderRunInput, "onEvent"> & {
  database?: RunnerDatabase;
  onLog?: ProviderRunInput["onEvent"];
  onRunComplete?: (output: ProviderRuntimeComplete) => void;
  onRunStart?: (input: ProviderRuntimeStart) => void;
  onRuntimeEvent?: ProviderRunInput["onEvent"];
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
    prompt: input.prompt,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    approvalPolicy: input.approvalPolicy,
    sandbox: input.sandbox,
    onEvent
  };
}

function persistRuntimeResult(input: RunnerIssueExecutionInput, provider: string, result: ProviderRunResult, activeRunID: string): void {
  if (!input.database || !result.session) return;
  persistRuntime({
    db: input.database, input, provider, session: result.session,
    status: "completed", metadata: { run_id: result.runId },
    issueRunId: activeRunID || openIssueRunID(input.database, input.issueId)
  });
}

function persistRuntimeEvent(input: RunnerIssueExecutionInput, event: ProviderEvent, activeRunID: string): void {
  if (!input.database) return;
  recordIssueLogEvent(input.database, input.issueId, event);
  if (!event.session) return;
  persistRuntime({
    db: input.database, input, provider: event.session.provider, session: event.session,
    status: event.status || "running", metadata: { source: "provider_event" },
    issueRunId: activeRunID
  });
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
    issue_run_id: args.issueRunId,
    provider: args.provider,
    provider_session_id: args.session.sessionId,
    provider_turn_id: args.session.turnId,
    metadata: args.metadata
  });
  if (args.session.sessionId === "") return;
  upsertAgentSession(args.db, {
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
