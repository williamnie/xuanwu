import { mustGetCurrentOpenIssueRun, updateIssueRuntime } from "../db/repositories/issueRuns.ts";
import { isProviderInterruptedError, type ExecutorProvider, type ProviderEvent, type ProviderRunResult } from "../providers/types.ts";
import { appendRunMemoryPrompt } from "../pi/memory/runMemoryContext.ts";
import { cleanString } from "../util/values.ts";
import type { RunnerIssueExecutionInput, RunnerIssueRecoveryInput } from "./providerRuntime.model.ts";
import { resolveRuntimePolicyOrPersist, providerInput, providerRecoveryInput } from "./providerRuntime.policy.ts";
import { runtimeMetadata } from "./providerRuntime.publication.ts";
import { providerEventSink, activeAttemptSequence } from "./providerRuntime.events.ts";
import { providerRunErrorEvent } from "./providerRuntime.errors.ts";
import { resetDebugIssueLogMode } from "./providerRuntime.outcomes.ts";
import { persistRuntimeResult } from "./providerRuntime.persistence.ts";

export async function runIssueWithProvider(
  provider: Pick<ExecutorProvider, "capabilities" | "id" | "manifest" | "policyAdapter" | "run" | "runtimeStatus">,
  input: RunnerIssueExecutionInput
): Promise<ProviderRunResult> {
  if (!provider.capabilities.includes("issue_execution")) {
    throw new Error('executor provider missing capability "issue_execution"');
  }
  const providerID = provider.id;
  const activeRun = input.database
    ? mustGetCurrentOpenIssueRun(input.database, input.issueId, cleanString(input.issueRunId))
    : undefined;
  input.onRunStart?.({
    provider: providerID,
    issueId: input.issueId,
    projectId: input.projectId,
    metadata: { cwd: input.cwd }
  });
  const activeRunID = activeRun?.id ?? "";
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
  const eventSink = providerEventSink(resolvedInput, activeRunID, activeAttemptSequence(resolvedInput, activeRunID, activeRun?.attempt ?? 0));
  let result: ProviderRunResult;
  try {
    const prompt = resolvedInput.database ? appendRunMemoryPrompt(
      resolvedInput.database, input.issueId, activeRunID, input.prompt, "execution"
    ) : input.prompt;
    result = await provider.run(providerInput({ ...resolvedInput, prompt }, eventSink.push));
  } catch (error) {
    if (!isProviderInterruptedError(error) && !eventSink.hasFailure()) {
      eventSink.push(providerRunErrorEvent(providerID, error));
    }
    throw error;
  } finally {
    try {
      await eventSink.flush();
    } finally {
      resetDebugIssueLogMode(resolvedInput, eventSink.mode, providerID);
    }
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
  const activeRun = input.database
    ? mustGetCurrentOpenIssueRun(input.database, input.issueId, cleanString(input.issueRunId))
    : undefined;
  const activeRunID = activeRun?.id ?? "";
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
  const eventSink = providerEventSink(resolvedInput, activeRunID, activeAttemptSequence(resolvedInput, activeRunID, activeRun?.attempt ?? 0));
  let result: ProviderRunResult;
  try {
    const prompt = resolvedInput.database ? appendRunMemoryPrompt(
      resolvedInput.database, input.issueId, activeRunID, input.prompt, "recovery"
    ) : input.prompt;
    result = await provider.recover(providerRecoveryInput({ ...resolvedInput, prompt }, eventSink.push));
  } catch (error) {
    if (!isProviderInterruptedError(error) && !eventSink.hasFailure()) {
      eventSink.push(providerRunErrorEvent(providerID, error));
    }
    throw error;
  } finally {
    try {
      await eventSink.flush();
    } finally {
      resetDebugIssueLogMode(resolvedInput, eventSink.mode, providerID);
    }
  }
  persistRuntimeResult(resolvedInput, providerID, result, activeRunID);
  return result;
}

export async function persistRecoveredProviderEvents(input: RunnerIssueExecutionInput, events: ProviderEvent[]): Promise<void> {
  const runID = cleanString(input.issueRunId);
  const sink = providerEventSink(input, runID, activeAttemptSequence(input, runID, 1));
  for (const event of events) sink.push(event);
  await sink.flush();
}
