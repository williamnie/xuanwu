import type { RunnerDatabase } from "../../db/database.ts";
import { issueTimestamp } from "../../db/repositories/issueCreate.ts";
import type { PreparedProviderMutation } from "./lifecycleStore.ts";
import {
  RUN_LIFECYCLE_EVENT_TYPES,
  RunCommandValidationError,
  appendLifecycleEvent,
  appendOutcome,
  assertAudit,
  assertNonNegative,
  auditPayload,
  commandFingerprint,
  mustGetAttempt,
  mustGetIntent,
  mustGetLatestAttempt,
  mustGetRun,
  preparedFromEvent,
  replayOutcome,
  replayPreparedMutation,
  required,
  safeError
} from "./lifecycleStore.ts";
import { type RunInterruptCommand } from "./serviceModel.ts";
import { interruptViolations } from "./serviceValidation.ts";

export function prepareRunInterrupt(
  db: RunnerDatabase,
  command: RunInterruptCommand
): PreparedProviderMutation {
  assertAudit(command.audit);
  assertNonNegative(command.expected_revision, "expected_revision");
  assertNonNegative(command.expected_attempt_revision, "expected_attempt_revision");
  const fingerprint = commandFingerprint("interrupt_prepare", command);
  const write = db.transaction(() => {
    const replay = replayPreparedMutation(db, command.audit.event_id, fingerprint);
    if (replay) return replay;
    const run = mustGetRun(db, command.issue_run_id, command.run_id);
    const attempt = mustGetLatestAttempt(db, run.legacy_id);
    const violations = interruptViolations(db, run, attempt, command);
    if (violations.length > 0) throw new RunCommandValidationError(violations.join("; "));
    appendLifecycleEvent(db, run.issue_id, RUN_LIFECYCLE_EVENT_TYPES.intent, {
      ...auditPayload(command.audit),
      after_revision: command.expected_revision + 1,
      attempt_id: attempt.attempt_id,
      before_revision: command.expected_revision,
      expected_attempt_revision: command.expected_attempt_revision,
      expected_revision: command.expected_revision,
      fingerprint,
      issue_run_id: run.legacy_id,
      operation: "interrupt",
      outcome: "prepared",
      provider_ref: command.provider_ref,
      run_id: command.run_id
    });
    return {
      attempt_id: attempt.attempt_id,
      completed: false,
      issue_id: run.issue_id,
      issue_run_id: run.legacy_id,
      replayed: false,
      should_invoke: true
    };
  });
  return write.immediate();
}

export function completeRunInterrupt(db: RunnerDatabase, eventID: string): PreparedProviderMutation {
  const outputFingerprint = commandFingerprint("interrupt_completed", { event_id: eventID });
  const write = db.transaction(() => {
    const intent = mustGetIntent(db, eventID);
    const replay = replayOutcome(db, eventID, outputFingerprint);
    if (replay) return preparedFromEvent(intent, true, true);
    const attempt = mustGetAttempt(db, required(intent.payload.attempt_id, "attempt_id"));
    if (attempt.status !== "running") throw new RunCommandValidationError(`${attempt.attempt_id} is not running`);
    const timestamp = issueTimestamp();
    db.sqlite.run(`update run_attempts set status='interrupted', revision=revision+1,
      ended_at=?, terminal_reason=?, terminal_source_ref=?, updated_at=?
      where attempt_id=? and status='running'`, [
      timestamp,
      "provider turn interrupted",
      `run-lifecycle:${eventID}`,
      timestamp,
      attempt.attempt_id
    ]);
    appendOutcome(db, intent, outputFingerprint, "interrupted", {});
    return preparedFromEvent(intent, false, true);
  });
  return write.immediate();
}

export function failRunInterrupt(db: RunnerDatabase, eventID: string, error: unknown): PreparedProviderMutation {
  const reason = safeError(error);
  const outputFingerprint = commandFingerprint("interrupt_failed", { reason });
  const write = db.transaction(() => {
    const intent = mustGetIntent(db, eventID);
    const replay = replayOutcome(db, eventID, outputFingerprint);
    if (replay) return preparedFromEvent(intent, true, true);
    appendOutcome(db, intent, outputFingerprint, "provider_failed", { error: reason });
    return preparedFromEvent(intent, false, true);
  });
  return write.immediate();
}
