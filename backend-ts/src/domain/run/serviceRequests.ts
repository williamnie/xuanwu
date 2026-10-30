import type { RunnerDatabase } from "../../db/database.ts";
import { readWorkspaceWait } from "../../db/repositories/workspaceWaits.ts";
import { cleanString } from "../../util/values.ts";
import {
  RUN_LIFECYCLE_EVENT_TYPES,
  RunCommandConflictError,
  RunCommandValidationError,
  appendLifecycleEvent,
  assertAudit,
  assertFingerprint,
  assertNonNegative,
  auditPayload,
  commandFingerprint,
  findLifecycleEvents,
  intentIssueID,
  mustGetLatestAttempt,
  mustGetRun,
  mustGetRunByLegacyID,
  numeric
} from "./lifecycleStore.ts";
import { type NewRunCommand, type NewRunRequestResult, type PendingRunCreation } from "./serviceModel.ts";
import { newRunViolations } from "./serviceValidation.ts";
import { nextRunSequence, closeSupersededRun, queueIssueForRun, recordStatusEvent } from "./serviceState.ts";

export function requestNewRun(db: RunnerDatabase, command: NewRunCommand): NewRunRequestResult {
  assertAudit(command.audit);
  assertNonNegative(command.expected_revision, "expected_revision");
  const fingerprint = commandFingerprint("new_run_request", command);
  const write = db.transaction(() => {
    const replay = replayNewRunRequest(db, command.audit.event_id, fingerprint);
    if (replay) return replay;
    const run = mustGetRun(db, command.issue_run_id, command.run_id);
    if (readWorkspaceWait(db, run.issue_id)?.state === "released") {
      throw new RunCommandConflictError("Workspace wait requires a current human answer before retry");
    }
    const latestAttempt = mustGetLatestAttempt(db, run.legacy_id);
    const violations = newRunViolations(db, run, latestAttempt, command);
    const requestedSequence = nextRunSequence(db, run.issue_id);
    if (violations.length > 0) {
      appendLifecycleEvent(db, run.issue_id, RUN_LIFECYCLE_EVENT_TYPES.runRequested, {
        ...auditPayload(command.audit),
        after_revision: command.expected_revision,
        before_revision: command.expected_revision,
        event_id: command.audit.event_id,
        fingerprint,
        issue_run_id: run.legacy_id,
        operation: command.operation,
        outcome: "rejected",
        requested_sequence: requestedSequence,
        run_id: command.run_id,
        violations
      });
      return newRunResult(command, run.issue_id, requestedSequence, false, false, violations);
    }

    if (command.operation === "supersede") closeSupersededRun(db, run, latestAttempt, command.audit);
    queueIssueForRun(db, run.issue_id, command);
    appendLifecycleEvent(db, run.issue_id, RUN_LIFECYCLE_EVENT_TYPES.runRequested, {
      ...auditPayload(command.audit),
      after_revision: command.expected_revision + 1,
      before_revision: command.expected_revision,
      event_id: command.audit.event_id,
      fingerprint,
      issue_run_id: run.legacy_id,
      operation: command.operation,
      outcome: "applied",
      requested_sequence: requestedSequence,
      run_id: command.run_id,
      supersedes_run_id: command.run_id
    });
    recordStatusEvent(db, run.issue_id, {
      reason: `run_${command.operation}`,
      status: "todo"
    }, command.audit.occurred_at);
    return newRunResult(command, run.issue_id, requestedSequence, true, false, []);
  });
  return write.immediate();
}

export function recordRunMaterialized(
  db: RunnerDatabase,
  request: PendingRunCreation,
  issueRunID: string
): void {
  const run = mustGetRunByLegacyID(db, issueRunID);
  if (run.issue_id !== request.issue_id || run.attempt !== request.requested_sequence) {
    throw new RunCommandValidationError("materialized Run does not match the pending request");
  }
  const existing = findLifecycleEvents(db, request.event_id, RUN_LIFECYCLE_EVENT_TYPES.runMaterialized)[0];
  if (existing) {
    if (existing.payload.new_issue_run_id !== issueRunID) throw new RunCommandConflictError(request.event_id);
    return;
  }
  appendLifecycleEvent(db, request.issue_id, RUN_LIFECYCLE_EVENT_TYPES.runMaterialized, {
    after_revision: 0,
    before_revision: 0,
    event_id: request.event_id,
    issue_run_id: issueRunID,
    new_issue_run_id: issueRunID,
    operation: request.operation,
    outcome: "materialized",
    requested_sequence: request.requested_sequence,
    run_id: run.run_id,
    supersedes_run_id: request.supersedes_run_id,
    trigger: request.operation
  });
}

function replayNewRunRequest(
  db: RunnerDatabase,
  eventID: string,
  fingerprint: string
): NewRunRequestResult | null {
  const event = findLifecycleEvents(db, eventID, RUN_LIFECYCLE_EVENT_TYPES.runRequested)[0];
  if (!event) return null;
  assertFingerprint(event, fingerprint);
  const operation = event.payload.operation;
  if (operation !== "retry" && operation !== "supersede") throw new RunCommandConflictError(eventID);
  const violations = Array.isArray(event.payload.violations) ? event.payload.violations : [];
  return {
    applied: event.payload.outcome === "applied",
    event_id: eventID,
    issue_id: intentIssueID(event),
    operation,
    replayed: true,
    requested_sequence: numeric(event.payload.requested_sequence, "requested_sequence"),
    violations
  };
}

function newRunResult(
  command: NewRunCommand,
  issueID: number,
  sequence: number,
  applied: boolean,
  replayed: boolean,
  violations: string[]
): NewRunRequestResult {
  return {
    applied,
    event_id: command.audit.event_id,
    issue_id: issueID,
    operation: command.operation,
    replayed,
    requested_sequence: sequence,
    violations
  };
}

export function agentSessionKey(db: RunnerDatabase, provider: unknown, sessionID: unknown): string | null {
  const key = `${cleanString(provider)}:${cleanString(sessionID)}`;
  if (key.endsWith(":")) return null;
  const row = db.sqlite.query<{ session_key: string }, [string]>(
    "select session_key from agent_sessions where session_key=?"
  ).get(key);
  return row?.session_key ?? null;
}
