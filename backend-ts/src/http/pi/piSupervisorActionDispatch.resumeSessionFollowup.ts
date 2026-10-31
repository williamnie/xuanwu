import { assertWorkspaceWaitSessionControl } from "../../db/repositories/workspaceWaits.ts";
import { recordIssueEvent } from "../../db/repositories/issueEvents.ts";
import { updateIssue } from "../../db/repositories/issueUpdate.ts";
import { completeRunAttemptStart, failRunAttemptStart } from "../../domain/run/service.ts";
import { type PiAction } from "../../db/repositories/pi.ts";
import { getProject } from "../../db/repositories/projects.ts";
import { updatePiRecoveryAttemptStatus } from "../../db/repositories/pi/recoveryAttempts.ts";
import { type ExecutorProviderId, type SessionMessageResult } from "../../providers/types.ts";
import { markResumeFollowupAttemptStarted, prepareResumeFollowupAttempt, resolveResumeFollowupReplay } from "./piSupervisorResumeIdempotency.ts";
import { prepareIssueRecoveryAttempt, issueRecoverySnapshot } from "./piSupervisorIssueRecoveryAttempts.ts";
import { assertFreshSupervisorState } from "./piSupervisorPreconditions.ts";
import { retryIssueWithInterrupt } from "../../runner/interrupt.ts";
import { startProjectLoop as defaultStartProjectLoop } from "../../runner/projectLoopManager.ts";
import { reconcileCurrentProviderTurn } from "../../runner/providerSessionReconciliation.ts";
import { recoverSupervisorIssue } from "./piSupervisorProviderRecovery.ts";
import { cleanString, errorMessage } from "../../util/values.ts";
import { getIssue } from "../../db/repositories/issues.ts";
import { providersForProjectID } from "../../nodes/remoteExecution.ts";
import type { SupervisorDispatchContext } from "./piSupervisorActionDispatch.model.ts";
import { positivePayloadID, sessionProviderID, sessionProviderSessionID, requiredText, recordSupervisorResult, prepareSupervisorResumeAttempt, resumeLifecycleEventID, persistFollowupRuntime } from "./piSupervisorActionDispatch.prepareSupervisorResumeAttempt.ts";

export async function resumeSessionFollowup(
  context: SupervisorDispatchContext,
  action: PiAction,
  payload: Record<string, unknown>
): Promise<unknown> {
  const issueID = positivePayloadID(payload, "issue_id");
  const providerID = sessionProviderID(payload);
  const sessionID = sessionProviderSessionID(payload);
  const prompt = requiredText(payload.prompt, "prompt");
  const provider = providersForProjectID(context.database, context.providers, getIssue(context.database, issueID)?.project_id ?? "")?.[providerID];
  assertWorkspaceWaitSessionControl(context.database, providerID, sessionID);
  if (!provider?.recover) throw new Error(`provider "${providerID}" 不支持 managed recovery`);
  const replay = await resolveResumeFollowupReplay(context.database, { action, issueID, payload, provider, providerID, sessionID });
  if (replay) {
    recordSupervisorResult(context.database, action, payload, replay.result);
    return replay.result;
  }
  assertFreshSupervisorState(context.database, issueID, providerID, sessionID, payload, [
    "expected_issue_updated_at", "expected_run_id", "expected_provider_turn_id", "expected_session_updated_at"
  ], "resume_revalidate");
  const observed = await reconcileCurrentProviderTurn({ database: context.database, issueID, provider, bus: context.bus });
  if (!["unsupported", "interrupted"].includes(observed)) {
    const result = { outcome: observed, skipped: true };
    recordSupervisorResult(context.database, action, payload, result);
    return result;
  }
  const prepared = await prepareResumeFollowupAttempt(context.database, { action, issueID, payload, provider, providerID, sessionID });
  if (prepared.skip) {
    recordSupervisorResult(context.database, action, payload, prepared.result);
    return prepared.result;
  }
  const lifecycle = prepareSupervisorResumeAttempt(
    context.database,
    issueID,
    action,
    payload,
    prepared.attempt.id,
    providerID,
    sessionID
  );
  if (!lifecycle.should_invoke) {
    const skipped = {
      outcome: lifecycle.completed ? "already_started" : "attempt_executing",
      provider_turn_id: "",
      skipped: true
    };
    recordSupervisorResult(context.database, action, payload, skipped);
    return skipped;
  }
  let result: SessionMessageResult;
  let started = false;
  try {
    result = await recoverSupervisorIssue(context, provider, {
      issueID, runID: requiredText(payload.expected_run_id, "expected_run_id"), sessionID,
      previousTurnID: requiredText(payload.expected_provider_turn_id, "expected_provider_turn_id"), prompt
    }, (runtime) => {
      const turnID = requiredText(runtime.turn_id, "provider turn id");
      completeRunAttemptStart(context.database, resumeLifecycleEventID(action), {
        invocation_ref: `${providerID}:${sessionID}:${turnID}`,
        provider_session_id: runtime.provider_session_id,
        provider_turn_id: turnID
      });
      started = true;
      persistFollowupRuntime(context.database, { action, issueID, providerID, result: runtime, sessionID });
      markResumeFollowupAttemptStarted(context.database, prepared.attempt.id, turnID);
    });
  } catch (error) {
    if (!started) failRunAttemptStart(context.database, resumeLifecycleEventID(action), error);
    updatePiRecoveryAttemptStatus(context.database, prepared.attempt.id, { error: errorMessage(error), status: "failed" });
    throw error;
  }
  const turnID = cleanString(result.turn_id);
  recordIssueEvent(context.database, issueID, "issue.supervisor_resume_followup", {
    action_id: action.id,
    decision_id: cleanString(payload.decision_id),
    provider: providerID,
    provider_session_id: sessionID,
    provider_turn_id: turnID
  });
  recordSupervisorResult(context.database, action, payload, { outcome: "started", provider_turn_id: turnID });
  return result;
}

export async function retryIssueNow(
  context: SupervisorDispatchContext,
  action: PiAction,
  payload: Record<string, unknown>
): Promise<unknown> {
  const issueID = positivePayloadID(payload, "issue_id");
  assertFreshSupervisorState(context.database, issueID, sessionProviderID(payload), "", payload, [
    "expected_issue_updated_at", "expected_run_id"
  ], "retry_revalidate");
  const reason = cleanString(payload.reason) || cleanString(payload.diagnosis_code) || "supervisor retry";
  const attempt = prepareIssueRecoveryAttempt(context.database, action, payload, {
    actionType: "issue.retry",
    issueID,
    status: "executing"
  });
  const before = issueRecoverySnapshot(context.database, issueID, payload);
  try {
    const issue = await retryIssueWithInterrupt(context.database, issueID, {}, { providers: context.providers });
    const after = issueRecoverySnapshot(context.database, issueID, payload);
    const progress = recoverySnapshotChanged(before, after);
    updatePiRecoveryAttemptStatus(context.database, attempt.id, {
      after_snapshot_json: after,
      progress_detected: progress ? 1 : 0,
      progress_reasons_json: progress ? ["issue_requeued"] : [],
      ignored_reasons_json: progress ? [] : ["retry_no_state_change"],
      status: progress ? "progress" : "no_progress"
    });
    recordIssueEvent(context.database, issueID, "issue.supervisor_retry", {
      action_id: action.id,
      decision_id: cleanString(payload.decision_id),
      reason
    });
    recordSupervisorResult(context.database, action, payload, {
      outcome: progress ? "queued" : "no_progress",
      reason,
      status: issue.status
    });
    if (progress && issue.status === "todo") startRetriedProjectLoop(context, issue.project_id);
    return issue;
  } catch (error) {
    updatePiRecoveryAttemptStatus(context.database, attempt.id, { error: errorMessage(error), status: "failed" });
    throw error;
  }
}

export function startRetriedProjectLoop(context: SupervisorDispatchContext, projectID: string): void {
  const project = getProject(context.database, projectID);
  const provider = project ? providersForProjectID(context.database, context.providers, project.id)?.[project.provider as ExecutorProviderId] : undefined;
  if (!project || project.auto_run !== 1 || !provider?.capabilities.includes("issue_execution")) return;
  const starter = context.startProjectLoop ?? defaultStartProjectLoop;
  starter({ bus: context.bus, database: context.database, providers: context.providers }, project.id);
}

export function recoverySnapshotChanged(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}

export function scheduleRetryAfter(
  context: SupervisorDispatchContext,
  action: PiAction,
  payload: Record<string, unknown>
): unknown {
  const issueID = positivePayloadID(payload, "issue_id");
  assertFreshSupervisorState(context.database, issueID, sessionProviderID(payload), "", payload, [
    "expected_issue_updated_at", "expected_run_id"
  ]);
  const retryAfterAt = requiredTime(payload.retry_after_at, "retry_after_at");
  const reason = requiredText(payload.reason, "reason");
  const attempt = prepareIssueRecoveryAttempt(context.database, action, payload, {
    actionType: "issue.retry_after",
    hardTimeoutAt: retryAfterAt,
    issueID,
    status: "planned"
  });
  try {
    const issue = updateIssue(context.database, issueID, { auto_retry_next_at: retryAfterAt, auto_retry_reason: reason });
    recordIssueEvent(context.database, issueID, "issue.retry_after_scheduled", {
      action_id: action.id,
      reason,
      retry_after_at: retryAfterAt,
      source_event_id: payload.source_event_id
    });
    recordSupervisorResult(context.database, action, payload, { outcome: "scheduled", retry_after_at: retryAfterAt });
    return issue;
  } catch (error) {
    updatePiRecoveryAttemptStatus(context.database, attempt.id, { error: errorMessage(error), status: "failed" });
    throw error;
  }
}

export function recordSupervisorDecision(
  context: SupervisorDispatchContext,
  action: PiAction,
  payload: Record<string, unknown>
): unknown {
  const issueID = positivePayloadID(payload, "issue_id");
  assertFreshSupervisorState(context.database, issueID, sessionProviderID(payload), "", payload, [
    "expected_issue_updated_at", "expected_run_id"
  ]);
  recordIssueEvent(context.database, issueID, "issue.supervisor_decision", {
    action_id: action.id,
    decision: payload.decision
  });
  recordSupervisorResult(context.database, action, payload, { outcome: "recorded" });
  return { recorded: true };
}

export function requiredTime(value: unknown, key: string): string {
  const text = requiredText(value, key);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${key} must be a valid time`);
  return text;
}
