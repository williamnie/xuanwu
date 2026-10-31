import { upsertAgentSession } from "../../db/repositories/agentSessions.ts";
import { getProject } from "../../db/repositories/projects.ts";
import { type RunAttemptView, type RunDetail } from "../../db/repositories/runs.ts";
import { updateIssueRuntime } from "../../db/repositories/issueRuns.ts";
import { completeRunAttemptStart, completeRunInterrupt, failRunAttemptStart, failRunInterrupt, prepareRunAttempt, prepareRunInterrupt } from "../../domain/run/service.ts";
import { type PreparedProviderMutation } from "../../domain/run/lifecycleStore.ts";
import { type RunID } from "../../domain/run/contracts.ts";
import { isExecutorProviderId, type ExecutorProvider, type ExecutorProviderId, type SessionMessageResult } from "../../providers/types.ts";
import { startProjectLoop } from "../../runner/projectLoopManager.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import { json } from "../errors.ts";
import type { ReadApiContext } from "../readApiContext.ts";
import { cleanString } from "../../util/values.ts";
import { providersForProjectID } from "../../nodes/remoteExecution.ts";
import { assertKeys, latestAttempt, revisionInput, auditInput, requiredString, issueIDFromWorkID } from "./runApi.transcriptResponse.ts";
import { runError, requireRun, publicRun } from "./runApi.listResponse.ts";
import type { RunAction } from "./runApi.model.ts";

export async function interruptRun(
  context: ReadApiContext,
  run: RunDetail,
  body: Record<string, unknown>
): Promise<Response | Record<string, unknown>> {
  assertKeys(body, ["audit", "expected_attempt_revision", "expected_revision"]);
  const attempt = latestAttempt(run);
  const expectedRevision = revisionInput(body.expected_revision, "expected_revision");
  const expectedAttemptRevision = revisionInput(body.expected_attempt_revision, "expected_attempt_revision");
  const audit = auditInput(body.audit);
  const provider = controlProvider(context, attempt, "interrupt", run.project_id);
  const sessionID = requiredControlRef(attempt.provider_ref.session_ref, "interrupt requires provider session ref");
  const turnID = requiredControlRef(attempt.provider_ref.turn_ref, "interrupt requires provider turn ref");
  const prepared = prepareRunInterrupt(context.database, {
    attempt_id: attempt.id,
    audit,
    expected_attempt_revision: expectedAttemptRevision,
    expected_revision: expectedRevision,
    issue_run_id: run.legacy.id,
    provider_ref: {
      invocation_ref: attempt.provider_ref.invocation_ref || run.legacy.id,
      provider: provider.id,
      session_ref: sessionID,
      turn_ref: turnID
    },
    run_id: run.id
  });
  if (!prepared.should_invoke) return replayResponse(context, run.id, "interrupt", audit.event_id, prepared);
  try {
    await provider.interrupt?.({
      reason: `run_http:${audit.event_id}`,
      session: { provider: provider.id, sessionId: sessionID, turnId: turnID }
    });
  } catch (error) {
    failRunInterrupt(context.database, audit.event_id, sanitizedError(error));
    throw runError(502, "provider_control_failed", "Provider interrupt failed");
  }
  completeRunInterrupt(context.database, audit.event_id);
  return mutationResponse(context, run.id, {
    action: "interrupt",
    audit_event_id: audit.event_id,
    replayed: false
  });
}

export async function resumeRun(
  context: ReadApiContext,
  run: RunDetail,
  body: Record<string, unknown>
): Promise<Response | Record<string, unknown>> {
  assertKeys(body, ["audit", "expected_attempt_revision", "expected_revision", "prompt"]);
  const attempt = latestAttempt(run);
  const expectedRevision = revisionInput(body.expected_revision, "expected_revision");
  const expectedAttemptRevision = revisionInput(body.expected_attempt_revision, "expected_attempt_revision");
  const prompt = requiredString(body.prompt, "prompt");
  const audit = auditInput(body.audit);
  const provider = controlProvider(context, attempt, "resume_session", run.project_id);
  const sessionID = requiredControlRef(attempt.provider_ref.session_ref, "resume requires provider session ref");
  const prepared = prepareRunAttempt(context.database, {
    audit,
    expected_attempt_revision: expectedAttemptRevision,
    expected_revision: expectedRevision,
    issue_run_id: run.legacy.id,
    kind: "resume",
    previous_attempt_terminal: {
      reason: "previous provider turn completed before authenticated Run resume",
      source_ref: `run-http:${audit.event_id}:precondition`,
      status: "succeeded"
    },
    provider_ref: { provider: provider.id, session_ref: sessionID },
    run_id: run.id
  });
  if (!prepared.should_invoke) return replayResponse(context, run.id, "resume", audit.event_id, prepared);
  let providerSessionID: string;
  let turnID: string;
  try {
    const result = await provider.sendSessionMessage?.({ prompt, sessionId: sessionID }) as SessionMessageResult;
    providerSessionID = cleanString(result.provider_session_id) || cleanString(result.sessionId) || sessionID;
    turnID = requiredString(result.turn_id, "provider turn id");
  } catch (error) {
    failRunAttemptStart(context.database, audit.event_id, sanitizedError(error));
    throw runError(502, "provider_control_failed", "Provider resume failed");
  }
  completeRunAttemptStart(context.database, audit.event_id, {
    invocation_ref: `${provider.id}:${providerSessionID}:${turnID}`,
    provider_session_id: providerSessionID,
    provider_turn_id: turnID
  });
  persistResumeRuntime(context, run, audit.event_id, provider.id, providerSessionID, turnID);
  return mutationResponse(context, run.id, {
    action: "resume",
    audit_event_id: audit.event_id,
    replayed: false
  });
}

export function replayResponse(
  context: ReadApiContext,
  runIDValue: RunID,
  action: RunAction,
  eventID: string,
  prepared: PreparedProviderMutation
): Response | Record<string, unknown> {
  if (!prepared.completed) {
    return json({
      code: "run_control_pending",
      message: "Run control intent is pending provider outcome and will not be invoked twice",
      mutation: { action, audit_event_id: eventID, pending: true, replayed: true },
      run: requireRun(context, runIDValue)
    }, { status: 202 });
  }
  return mutationResponse(context, runIDValue, {
    action,
    audit_event_id: eventID,
    replayed: true
  });
}

export function mutationResponse(
  context: ReadApiContext,
  id: RunID,
  mutation: Record<string, unknown>
): Record<string, unknown> {
  return {
    mutation: { applied: true, ...mutation },
    run: publicRun(requireRun(context, id))
  };
}

export function persistResumeRuntime(
  context: ReadApiContext,
  run: RunDetail,
  eventID: string,
  provider: ExecutorProviderId,
  sessionID: string,
  turnID: string
): void {
  const issueID = issueIDFromWorkID(run.work_id);
  updateIssueRuntime(context.database, issueID, {
    issue_run_id: run.legacy.id,
    metadata: { run_http_event_id: eventID, run_http_resume: true },
    provider,
    provider_session_id: sessionID,
    provider_turn_id: turnID
  });
  upsertAgentSession(context.database, {
    issue_id: issueID,
    project_id: run.project_id,
    provider,
    provider_session_id: sessionID,
    raw_ref: { provider_turn_id: turnID, run_http_event_id: eventID },
    status: "running"
  });
}

export function controlProvider(
  context: ReadApiContext,
  attempt: RunAttemptView,
  capability: "interrupt" | "resume_session",
  projectID: string
): ExecutorProvider {
  const providerID = attempt.provider_ref.provider;
  if (!isExecutorProviderId(providerID)) {
    throw runError(409, "provider_control_unavailable", `Provider ${providerID} is not controllable`);
  }
  const provider = providersForProjectID(context.database, context.providers, projectID)?.[providerID];
  const supported = capability === "interrupt" ? provider?.interrupt : provider?.sendSessionMessage;
  if (!provider || !supported || !provider.capabilities.includes(capability)) {
    throw runError(409, "provider_control_unavailable", `Provider ${providerID} does not support ${capability}`);
  }
  return provider;
}

export function requiredControlRef(value: unknown, message: string): string {
  const text = cleanString(value);
  if (!text) throw runError(409, "provider_control_unavailable", message);
  return text;
}

export function kickProject(context: ReadApiContext, projectID: string): void {
  const project = getProject(context.database, projectID);
  if (!project || project.auto_run !== 1) return;
  startProjectLoop({
    bus: context.bus,
    database: context.database,
    providers: context.providers
  }, project.id);
}

export function sanitizedError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(redactSensitiveText(message));
}
