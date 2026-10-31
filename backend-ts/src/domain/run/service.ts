import type { RunnerDatabase } from "../../db/database.ts";
import {
  findRunRevisionIssueScopeMismatches,
  type RunRevisionIssueScopeMismatch
} from "../../db/runRevisionScopeAudit.ts";
import { issueTimestamp } from "../../db/repositories/issueCreate.ts";
import { assertWorkspaceWaitSessionControl } from "../../db/repositories/workspaceWaits.ts";
import { emptyRunCost, makeRunAttemptID } from "./contracts.ts";
import { cleanString } from "../../util/values.ts";
import type { PreparedProviderMutation } from "./lifecycleStore.ts";
import {
  RUN_LIFECYCLE_EVENT_TYPES,
  RunCommandConflictError,
  RunCommandValidationError,
  appendLifecycleEvent,
  assertAudit,
  assertNonNegative,
  auditPayload,
  commandFingerprint,
  intentIssueID,
  mustGetAttempt,
  mustGetIntent,
  mustGetLatestAttempt,
  mustGetRun,
  numeric,
  parsedJsonObject,
  preparedFromEvent,
  replayOutcome,
  replayPreparedMutation,
  required,
  safeError
} from "./lifecycleStore.ts";
import { type RunAttemptCommand, type ProviderAttemptStart } from "./serviceModel.ts";
import { attemptPreparationViolations } from "./serviceValidation.ts";
import { closeAttempt } from "./serviceState.ts";
import { agentSessionKey } from "./serviceRequests.ts";

/** Deployment preflight for the historical invariant required by Issue-scoped revision reads. */
export function auditRunRevisionIssueScope(
  db: RunnerDatabase,
  limit = 20
): RunRevisionIssueScopeMismatch[] {
  return findRunRevisionIssueScopeMismatches(db.sqlite, limit);
}

export function prepareRunAttempt(
  db: RunnerDatabase,
  command: RunAttemptCommand
): PreparedProviderMutation {
  assertAudit(command.audit);
  assertNonNegative(command.expected_revision, "expected_revision");
  assertNonNegative(command.expected_attempt_revision, "expected_attempt_revision");
  const fingerprint = commandFingerprint("attempt_prepare", command);
  const write = db.transaction(() => {
    const replay = replayPreparedMutation(db, command.audit.event_id, fingerprint);
    if (replay) return replay;
    const run = mustGetRun(db, command.issue_run_id, command.run_id);
    const attempt = mustGetLatestAttempt(db, run.legacy_id);
    try { assertWorkspaceWaitSessionControl(db, command.provider_ref.provider, cleanString(command.provider_ref.session_ref)); }
    catch (error) { throw new RunCommandConflictError(error instanceof Error ? error.message : String(error)); }
    const violations = attemptPreparationViolations(db, run, attempt, command);
    if (violations.length > 0) throw new RunCommandValidationError(violations.join("; "));

    closeAttempt(db, attempt, command.previous_attempt_terminal, command.audit.occurred_at);
    const sequence = attempt.sequence + 1;
    const attemptID = makeRunAttemptID(command.run_id, sequence);
    db.sqlite.run(`insert into run_attempts (
      attempt_id, run_id, issue_run_id, sequence, kind, status, legacy_status,
      mapping_error, revision, provider, provider_invocation_ref, provider_session_id,
      provider_turn_id, agent_session_key, cost_json, created_at, updated_at
    ) values (?, ?, ?, ?, ?, 'created', '', '', 0, ?, '', ?, '', ?, ?, ?, ?)`, [
      attemptID,
      command.run_id,
      run.legacy_id,
      sequence,
      command.kind,
      cleanString(command.provider_ref.provider),
      cleanString(command.provider_ref.session_ref),
      agentSessionKey(db, command.provider_ref.provider, command.provider_ref.session_ref),
      JSON.stringify(emptyRunCost()),
      command.audit.occurred_at,
      command.audit.occurred_at
    ]);
    appendLifecycleEvent(db, run.issue_id, RUN_LIFECYCLE_EVENT_TYPES.intent, {
      ...auditPayload(command.audit),
      after_revision: command.expected_revision + 1,
      attempt_id: attemptID,
      before_revision: command.expected_revision,
      expected_attempt_revision: command.expected_attempt_revision,
      expected_revision: command.expected_revision,
      fingerprint,
      issue_run_id: run.legacy_id,
      operation: command.kind,
      outcome: "prepared",
      previous_attempt_id: attempt.attempt_id,
      previous_attempt_terminal: command.previous_attempt_terminal,
      provider_usage_baseline: {
        attempt_id: attempt.attempt_id,
        attempt_revision: attempt.revision,
        cost: parsedJsonObject(attempt.cost_json)
      },
      provider_ref: command.provider_ref,
      run_id: command.run_id
    });
    return {
      attempt_id: attemptID,
      completed: false,
      issue_id: run.issue_id,
      issue_run_id: run.legacy_id,
      replayed: false,
      should_invoke: true
    };
  });
  return write.immediate();
}

export function completeRunAttemptStart(
  db: RunnerDatabase,
  eventID: string,
  result: ProviderAttemptStart
): PreparedProviderMutation {
  const outputFingerprint = commandFingerprint("attempt_started", result);
  const write = db.transaction(() => {
    const intent = mustGetIntent(db, eventID);
    const replay = replayOutcome(db, eventID, outputFingerprint);
    if (replay) return preparedFromEvent(intent, true, true);
    const attempt = mustGetAttempt(db, required(intent.payload.attempt_id, "attempt_id"));
    if (attempt.status !== "created") throw new RunCommandValidationError(`${attempt.attempt_id} is not prepared`);
    const invocation = required(result.invocation_ref, "invocation_ref");
    const sessionID = cleanString(result.provider_session_id);
    const turnID = cleanString(result.provider_turn_id);
    const intendedSession = cleanString(intent.payload.provider_ref?.session_ref);
    if (intendedSession !== "" && intendedSession !== sessionID) {
      throw new RunCommandValidationError("provider result session does not match prepared Attempt");
    }
    const timestamp = issueTimestamp();
    db.sqlite.run(`update run_attempts set status='running', revision=revision+1,
      provider_invocation_ref=?, provider_session_id=?, provider_turn_id=?,
      agent_session_key=?, started_at=?, updated_at=?
      where attempt_id=? and status='created'`, [
      invocation,
      sessionID,
      turnID,
      agentSessionKey(db, attempt.provider, sessionID),
      timestamp,
      timestamp,
      attempt.attempt_id
    ]);
    const beforeRevision = numeric(intent.payload.after_revision, "intent after_revision");
    appendLifecycleEvent(db, intentIssueID(intent), RUN_LIFECYCLE_EVENT_TYPES.outcome, {
      after_revision: beforeRevision + 1,
      attempt_id: attempt.attempt_id,
      before_revision: beforeRevision,
      event_id: eventID,
      fingerprint: outputFingerprint,
      issue_run_id: required(intent.payload.issue_run_id, "issue_run_id"),
      operation: intent.payload.operation,
      outcome: "provider_started",
      provider_ref: {
        invocation_ref: invocation,
        provider: attempt.provider,
        session_ref: sessionID,
        turn_ref: turnID
      },
      run_id: required(intent.payload.run_id, "run_id")
    });
    return preparedFromEvent(intent, false, true);
  });
  return write.immediate();
}

export function failRunAttemptStart(db: RunnerDatabase, eventID: string, error: unknown): PreparedProviderMutation {
  const reason = safeError(error);
  const outputFingerprint = commandFingerprint("attempt_failed", { reason });
  const write = db.transaction(() => {
    const intent = mustGetIntent(db, eventID);
    const replay = replayOutcome(db, eventID, outputFingerprint);
    if (replay) return preparedFromEvent(intent, true, true);
    const attempt = mustGetAttempt(db, required(intent.payload.attempt_id, "attempt_id"));
    if (attempt.status !== "created") throw new RunCommandValidationError(`${attempt.attempt_id} is not prepared`);
    const timestamp = issueTimestamp();
    db.sqlite.run(`update run_attempts set status='failed', revision=revision+1,
      provider_invocation_ref=case when provider_invocation_ref='' then ? else provider_invocation_ref end,
      ended_at=?, terminal_reason=?, terminal_source_ref=?, updated_at=?
      where attempt_id=? and status='created'`, [
      `run-lifecycle:${eventID}:provider-call`,
      timestamp,
      reason,
      `run-lifecycle:${eventID}`,
      timestamp,
      attempt.attempt_id
    ]);
    const beforeRevision = numeric(intent.payload.after_revision, "intent after_revision");
    appendLifecycleEvent(db, intentIssueID(intent), RUN_LIFECYCLE_EVENT_TYPES.outcome, {
      after_revision: beforeRevision + 1,
      attempt_id: attempt.attempt_id,
      before_revision: beforeRevision,
      error: reason,
      event_id: eventID,
      fingerprint: outputFingerprint,
      issue_run_id: required(intent.payload.issue_run_id, "issue_run_id"),
      operation: intent.payload.operation,
      outcome: "provider_failed",
      run_id: required(intent.payload.run_id, "run_id")
    });
    return preparedFromEvent(intent, false, true);
  });
  return write.immediate();
}

export type { RunAttemptCommand } from "./serviceModel.ts";
export type { RunInterruptCommand } from "./serviceModel.ts";
export type { NewRunCommand } from "./serviceModel.ts";
export { readRunRevision } from "./serviceState.ts";
export { prepareRunInterrupt } from "./serviceInterrupt.ts";
export { completeRunInterrupt } from "./serviceInterrupt.ts";
export { failRunInterrupt } from "./serviceInterrupt.ts";
export { requestNewRun } from "./serviceRequests.ts";
export { pendingRunCreation } from "./serviceState.ts";
export { recordRunMaterialized } from "./serviceRequests.ts";
export { pendingNewRunRequest } from "./serviceState.ts";
