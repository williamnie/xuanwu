import type { RunnerDatabase } from "../../db/database.ts";
import { type RunID, type RunTransitionAudit } from "./contracts.ts";
import { cleanString, unique } from "../../util/values.ts";
import type { AttemptRow, RunRow } from "./lifecycleStore.ts";
import { TERMINAL_RUN_STATUSES } from "./lifecycleStore.ts";
import { type RunAttemptCommand, type RunInterruptCommand, type NewRunCommand } from "./serviceModel.ts";
import { pendingNewRunRequest, readRunRevision } from "./serviceState.ts";

export function attemptPreparationViolations(
  db: RunnerDatabase,
  run: RunRow,
  attempt: AttemptRow,
  command: RunAttemptCommand
): string[] {
  const violations = commandViolations(db, run, command.expected_revision, command.audit);
  if (run.status !== "in_progress" || run.ended_at !== "") violations.push("Run must be non-terminal");
  if (attempt.revision !== command.expected_attempt_revision) {
    violations.push(`Attempt revision mismatch: expected ${command.expected_attempt_revision}, actual ${attempt.revision}`);
  }
  if (attempt.status !== command.previous_attempt_terminal.status && attempt.status !== "running") {
    violations.push(`latest Attempt ${attempt.attempt_id} cannot close as ${command.previous_attempt_terminal.status}`);
  }
  if (command.kind === "resume" && command.previous_attempt_terminal.status !== "succeeded") {
    violations.push("resume requires a succeeded previous Attempt");
  }
  if (command.kind === "recovery" && !["failed", "interrupted"].includes(command.previous_attempt_terminal.status)) {
    violations.push("recovery requires a failed or interrupted previous Attempt");
  }
  if (cleanString(command.provider_ref.provider) !== run.provider) violations.push("Attempt provider must match its Run");
  if (cleanString(command.provider_ref.session_ref) === "") violations.push("resume/recovery requires provider session ref");
  if (attempt.provider_session_id !== "" && attempt.provider_session_id !== cleanString(command.provider_ref.session_ref)) {
    violations.push("resume/recovery must continue the existing provider session");
  }
  return unique(violations);
}

export function interruptViolations(
  db: RunnerDatabase,
  run: RunRow,
  attempt: AttemptRow,
  command: RunInterruptCommand
): string[] {
  const violations = commandViolations(db, run, command.expected_revision, command.audit);
  if (run.status !== "in_progress" || run.ended_at !== "") violations.push("Run must be non-terminal");
  if (attempt.attempt_id !== command.attempt_id) violations.push("only the latest Attempt can be interrupted");
  if (attempt.status !== "running") violations.push("interrupt requires a running Attempt");
  if (attempt.revision !== command.expected_attempt_revision) {
    violations.push(`Attempt revision mismatch: expected ${command.expected_attempt_revision}, actual ${attempt.revision}`);
  }
  if (attempt.provider !== cleanString(command.provider_ref.provider)) violations.push("provider ref does not match Attempt");
  if (attempt.provider_session_id !== "" && attempt.provider_session_id !== cleanString(command.provider_ref.session_ref)) {
    violations.push("session ref does not match Attempt");
  }
  if (attempt.provider_turn_id !== "" && attempt.provider_turn_id !== cleanString(command.provider_ref.turn_ref)) {
    violations.push("turn ref does not match Attempt");
  }
  return unique(violations);
}

export function newRunViolations(
  db: RunnerDatabase,
  run: RunRow,
  attempt: AttemptRow,
  command: NewRunCommand
): string[] {
  const violations = commandViolations(db, run, command.expected_revision, command.audit);
  if (pendingNewRunRequest(db, run.issue_id)) violations.push("a new Run request is already pending");
  if (command.operation === "retry" && (!TERMINAL_RUN_STATUSES.has(run.status) || run.ended_at === "")) {
    violations.push("retry requires a terminal Run");
  }
  if (command.operation === "supersede") {
    if (run.status !== "in_progress" || run.ended_at !== "") violations.push("supersede requires a non-terminal Run");
    if (attempt.status !== "interrupted") violations.push("supersede requires the active Attempt to be interrupted first");
  }
  return unique(violations);
}

function commandViolations(
  db: RunnerDatabase,
  run: RunRow,
  expectedRevision: number,
  audit: RunTransitionAudit
): string[] {
  const violations: string[] = [];
  const revision = readRunRevision(db, run.issue_id, run.run_id as RunID);
  if (revision !== expectedRevision) violations.push(`Run revision mismatch: expected ${expectedRevision}, actual ${revision}`);
  if (audit.gate.decision !== "allow") violations.push(`gate decision ${audit.gate.decision} does not allow mutation`);
  return violations;
}
