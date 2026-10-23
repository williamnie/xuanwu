import type { RunnerDatabase } from "../../db/database.ts";
import {
  findRunRevisionIssueScopeMismatches,
  type RunRevisionIssueScopeMismatch
} from "../../db/runRevisionScopeAudit.ts";
import { issueTimestamp } from "../../db/repositories/issueCreate.ts";
import { assertWorkspaceWaitSessionControl, readWorkspaceWait } from "../../db/repositories/workspaceWaits.ts";
import {
  emptyRunCost,
  makeRunAttemptID,
  type AttemptKind,
  type AttemptTerminalStatus,
  type ProviderAttemptRef,
  type RunID,
  type RunTransitionAudit
} from "./contracts.ts";
import { cleanString, unique } from "../../util/values.ts";
import type { AttemptRow, PreparedProviderMutation, RunRow } from "./lifecycleStore.ts";
import {
  RUN_LIFECYCLE_EVENT_TYPES, RunCommandConflictError, RunCommandValidationError, TERMINAL_RUN_STATUSES,
  appendLifecycleEvent, appendOutcome, assertAudit, assertFingerprint, assertNonNegative, auditPayload,
  commandFingerprint, findLifecycleEvents, intentIssueID, mustGetAttempt, mustGetIntent, mustGetLatestAttempt,
  mustGetRun, mustGetRunByLegacyID, numeric, parsePayload, parsedJsonObject, preparedFromEvent, replayOutcome,
  replayPreparedMutation, required, safeError
} from "./lifecycleStore.ts";

export type RunAttemptCommand = {
  audit: RunTransitionAudit;
  expected_attempt_revision: number;
  expected_revision: number;
  issue_run_id: string;
  kind: Exclude<AttemptKind, "initial">;
  previous_attempt_terminal: {
    reason: string;
    source_ref: string;
    status: Extract<AttemptTerminalStatus, "failed" | "interrupted" | "succeeded">;
  };
  provider_ref: Pick<ProviderAttemptRef, "provider"> & Partial<Pick<ProviderAttemptRef, "session_ref">>;
  run_id: RunID;
};

export type RunInterruptCommand = {
  attempt_id: string;
  audit: RunTransitionAudit;
  expected_attempt_revision: number;
  expected_revision: number;
  issue_run_id: string;
  provider_ref: ProviderAttemptRef;
  run_id: RunID;
};

export type NewRunCommand = {
  audit: RunTransitionAudit;
  expected_revision: number;
  issue_run_id: string;
  operation: "retry" | "supersede";
  run_id: RunID;
  service_tier?: string;
  service_tier_provided?: boolean;
};

type ProviderAttemptStart = {
  invocation_ref: string;
  provider_session_id?: string;
  provider_turn_id?: string;
};

type NewRunRequestResult = {
  applied: boolean;
  event_id: string;
  issue_id: number;
  operation: NewRunCommand["operation"];
  replayed: boolean;
  requested_sequence: number;
  violations: string[];
};

type PendingRunCreation = {
  event_id: string;
  issue_id: number;
  operation: NewRunCommand["operation"];
  requested_sequence: number;
  supersedes_run_id: RunID;
};

/** Deployment preflight for the historical invariant required by Issue-scoped revision reads. */
export function auditRunRevisionIssueScope(
  db: RunnerDatabase,
  limit = 20
): RunRevisionIssueScopeMismatch[] {
  return findRunRevisionIssueScopeMismatches(db.sqlite, limit);
}

export function readRunRevision(db: RunnerDatabase, issueID: number, runID: RunID): number {
  const row = db.sqlite.query<{ revision: number | null }, [number, string, string, string, string, string]>(`
    select max(cast(json_extract(payload, '$.after_revision') as integer)) as revision
    from issue_events
    where issue_id=?
      and type in (?, ?, ?, ?)
      and json_valid(payload)
      and json_extract(payload, '$.run_id')=?
  `).get(
    issueID,
    RUN_LIFECYCLE_EVENT_TYPES.intent,
    RUN_LIFECYCLE_EVENT_TYPES.outcome,
    RUN_LIFECYCLE_EVENT_TYPES.runMaterialized,
    RUN_LIFECYCLE_EVENT_TYPES.runRequested,
    runID
  );
  return row?.revision ?? 0;
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

export function pendingRunCreation(
  db: RunnerDatabase,
  issueID: number,
  sequence: number
): PendingRunCreation | null {
  const rows = db.sqlite.query<{ payload: string }, [number, string, number, string]>(`
    select request.payload from issue_events request
    where request.issue_id=? and request.type=? and json_valid(request.payload)
      and json_extract(request.payload, '$.requested_sequence')=?
      and json_extract(request.payload, '$.outcome')='applied'
      and not exists (
        select 1 from issue_events materialized
        where materialized.issue_id=request.issue_id and materialized.type=?
          and json_valid(materialized.payload)
          and json_extract(materialized.payload, '$.event_id')=json_extract(request.payload, '$.event_id')
      )
    order by request.id desc limit 1
  `).all(issueID, RUN_LIFECYCLE_EVENT_TYPES.runRequested, sequence, RUN_LIFECYCLE_EVENT_TYPES.runMaterialized);
  if (!rows[0]) return null;
  const payload = parsePayload(rows[0].payload);
  const operation = payload.operation;
  if (operation !== "retry" && operation !== "supersede") return null;
  return {
    event_id: required(payload.event_id, "event_id"),
    issue_id: issueID,
    operation,
    requested_sequence: numeric(payload.requested_sequence, "requested_sequence"),
    supersedes_run_id: required(payload.supersedes_run_id, "supersedes_run_id") as RunID
  };
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

export function pendingNewRunRequest(db: RunnerDatabase, issueID: number): boolean {
  const sequence = nextRunSequence(db, issueID);
  return pendingRunCreation(db, issueID, sequence) !== null;
}

function attemptPreparationViolations(
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

function interruptViolations(
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

function newRunViolations(
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

function closeAttempt(
  db: RunnerDatabase,
  attempt: AttemptRow,
  terminal: RunAttemptCommand["previous_attempt_terminal"],
  timestamp: string
): void {
  if (attempt.status === terminal.status) return;
  if (attempt.status !== "running") throw new RunCommandValidationError(`${attempt.attempt_id} is not running`);
  db.sqlite.run(`update run_attempts set status=?, revision=revision+1, ended_at=?,
    terminal_reason=?, terminal_source_ref=?, updated_at=? where attempt_id=? and status='running'`, [
    terminal.status,
    timestamp,
    required(terminal.reason, "previous_attempt_terminal.reason"),
    required(terminal.source_ref, "previous_attempt_terminal.source_ref"),
    timestamp,
    attempt.attempt_id
  ]);
}

function closeSupersededRun(
  db: RunnerDatabase,
  run: RunRow,
  attempt: AttemptRow,
  audit: RunTransitionAudit
): void {
  const sequence = nextRunSequence(db, run.issue_id);
  const replacementRunID = `xw:run:issue_runs:issue-${run.issue_id}-attempt-${sequence}`;
  const reason = `superseded_by:${replacementRunID}`;
  db.sqlite.run(`update issue_runs set status='cancelled', ended_at=?, exit_reason=?, error=''
    where id=? and ended_at=''`, [audit.occurred_at, reason, run.legacy_id]);
  // The P03.02 compatibility trigger mirrors a terminal legacy Run into the
  // initial Attempt when no later Attempt exists. Supersede has already
  // interrupted that Attempt, so restore the more precise child fact.
  db.sqlite.run(`update run_attempts set status='interrupted', ended_at=?,
    terminal_reason='provider turn interrupted before supersede',
    terminal_source_ref=?, updated_at=? where attempt_id=?`, [
    audit.occurred_at,
    `run-lifecycle:${audit.event_id}`,
    audit.occurred_at,
    attempt.attempt_id
  ]);
}

function queueIssueForRun(db: RunnerDatabase, issueID: number, command: NewRunCommand): void {
  const hasTier = command.service_tier_provided === true;
  const tier = cleanString(command.service_tier);
  db.sqlite.run(`update issues set status='todo', error='', codex_thread_id='', codex_turn_id='',
    service_tier=case when ?=1 then ? else service_tier end,
    auto_retry_next_at='', auto_retry_reason='', updated_at=? where id=?`, [
    hasTier ? 1 : 0,
    tier,
    command.audit.occurred_at,
    issueID
  ]);
}

function recordStatusEvent(
  db: RunnerDatabase,
  issueID: number,
  payload: Record<string, string>,
  timestamp: string
): void {
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, 'issue.status_changed', ?, ?)`,
    [issueID, JSON.stringify(payload), timestamp]
  );
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

function nextRunSequence(db: RunnerDatabase, issueID: number): number {
  return db.sqlite.query<{ sequence: number }, [number]>(
    "select coalesce(max(attempt), 0) + 1 as sequence from issue_runs where issue_id=?"
  ).get(issueID)?.sequence ?? 1;
}

function agentSessionKey(db: RunnerDatabase, provider: unknown, sessionID: unknown): string | null {
  const key = `${cleanString(provider)}:${cleanString(sessionID)}`;
  if (key.endsWith(":")) return null;
  const row = db.sqlite.query<{ session_key: string }, [string]>(
    "select session_key from agent_sessions where session_key=?"
  ).get(key);
  return row?.session_key ?? null;
}
