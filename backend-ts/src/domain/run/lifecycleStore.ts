import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../../db/database.ts";
import { RUN_REVISION_EVENT_TYPES } from "../../db/runRevisionScopeAudit.ts";
import { issueTimestamp } from "../../db/repositories/issueCreate.ts";
import { type AttemptKind, type ProviderAttemptRef, type RunID, type RunTransitionAudit } from "./contracts.ts";
import { cleanString } from "../../util/values.ts";

/** Run lifecycle event store: intent/outcome events, replay, command fingerprints and row lookups shared by the Run commands. */

export const RUN_LIFECYCLE_EVENT_TYPES = {
  intent: RUN_REVISION_EVENT_TYPES[0],
  outcome: RUN_REVISION_EVENT_TYPES[1],
  runMaterialized: RUN_REVISION_EVENT_TYPES[2],
  runRequested: RUN_REVISION_EVENT_TYPES[3]
} as const;

export type PreparedProviderMutation = {
  attempt_id: string;
  completed: boolean;
  issue_id: number;
  issue_run_id: string;
  replayed: boolean;
  should_invoke: boolean;
};

export type RunRow = {
  attempt: number;
  ended_at: string;
  issue_id: number;
  legacy_id: string;
  provider: string;
  run_id: string;
  status: string;
};

export type AttemptRow = {
  attempt_id: string;
  cost_json: string;
  kind: AttemptKind;
  provider: string;
  provider_invocation_ref: string;
  provider_session_id: string;
  provider_turn_id: string;
  revision: number;
  sequence: number;
  status: string | null;
};

type LifecycleEvent = {
  created_at: string;
  id: number;
  payload: LifecyclePayload;
  type: string;
};

type LifecyclePayload = {
  after_revision?: number;
  attempt_id?: string;
  before_revision?: number;
  event_id?: string;
  fingerprint?: string;
  issue_run_id?: string;
  new_issue_run_id?: string;
  operation?: string;
  outcome?: string;
  provider_ref?: Partial<ProviderAttemptRef>;
  requested_sequence?: number;
  run_id?: string;
  supersedes_run_id?: string;
  violations?: string[];
};

export const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

export class RunCommandValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunCommandValidationError";
  }
}

export class RunCommandConflictError extends Error {
  constructor(eventID: string) {
    super(`Run lifecycle event ${eventID} is already bound to another command`);
    this.name = "RunCommandConflictError";
  }
}

export function replayPreparedMutation(
  db: RunnerDatabase,
  eventID: string,
  fingerprint: string
): PreparedProviderMutation | null {
  const intent = findLifecycleEvents(db, eventID, RUN_LIFECYCLE_EVENT_TYPES.intent)[0];
  if (!intent) return null;
  assertFingerprint(intent, fingerprint);
  const outcome = findLifecycleEvents(db, eventID, RUN_LIFECYCLE_EVENT_TYPES.outcome)[0];
  return preparedFromEvent(intent, true, Boolean(outcome));
}

export function replayOutcome(
  db: RunnerDatabase,
  eventID: string,
  fingerprint: string
): LifecycleEvent | null {
  const outcome = findLifecycleEvents(db, eventID, RUN_LIFECYCLE_EVENT_TYPES.outcome)[0];
  if (!outcome) return null;
  assertFingerprint(outcome, fingerprint);
  return outcome;
}

export function preparedFromEvent(intent: LifecycleEvent, replayed: boolean, completed: boolean): PreparedProviderMutation {
  return {
    attempt_id: required(intent.payload.attempt_id, "attempt_id"),
    completed,
    issue_id: intentIssueID(intent),
    issue_run_id: required(intent.payload.issue_run_id, "issue_run_id"),
    replayed,
    should_invoke: !replayed
  };
}

export function appendOutcome(
  db: RunnerDatabase,
  intent: LifecycleEvent,
  fingerprint: string,
  outcome: string,
  extra: Record<string, unknown>
): void {
  const beforeRevision = numeric(intent.payload.after_revision, "intent after_revision");
  appendLifecycleEvent(db, intentIssueID(intent), RUN_LIFECYCLE_EVENT_TYPES.outcome, {
    after_revision: beforeRevision + 1,
    attempt_id: required(intent.payload.attempt_id, "attempt_id"),
    before_revision: beforeRevision,
    event_id: required(intent.payload.event_id, "event_id"),
    fingerprint,
    issue_run_id: required(intent.payload.issue_run_id, "issue_run_id"),
    operation: intent.payload.operation,
    outcome,
    run_id: required(intent.payload.run_id, "run_id"),
    ...extra
  });
}

export function mustGetIntent(db: RunnerDatabase, eventID: string): LifecycleEvent {
  const intent = findLifecycleEvents(db, eventID, RUN_LIFECYCLE_EVENT_TYPES.intent)[0];
  if (!intent) throw new RunCommandValidationError(`Run lifecycle intent ${eventID} not found`);
  return intent;
}

export function mustGetRun(db: RunnerDatabase, issueRunID: string, runID: RunID): RunRow {
  const run = mustGetRunByLegacyID(db, issueRunID);
  if (run.run_id !== runID) throw new RunCommandValidationError(`${issueRunID} does not map to ${runID}`);
  return run;
}

export function mustGetRunByLegacyID(db: RunnerDatabase, issueRunID: string): RunRow {
  const row = db.sqlite.query<RunRow, [string]>(`
    select id as legacy_id, issue_id, attempt, status, provider, ended_at, run_id
    from issue_runs where id=?
  `).get(required(issueRunID, "issue_run_id"));
  if (!row) throw new RunCommandValidationError(`issue Run ${issueRunID} not found`);
  return row;
}

export function mustGetLatestAttempt(db: RunnerDatabase, issueRunID: string): AttemptRow {
  const row = db.sqlite.query<AttemptRow, [string]>(`
    select attempt_id, sequence, kind, status, revision, provider, cost_json,
      provider_invocation_ref, provider_session_id, provider_turn_id
    from run_attempts where issue_run_id=? order by sequence desc limit 1
  `).get(issueRunID);
  if (!row) throw new RunCommandValidationError(`Run ${issueRunID} has no Attempt`);
  return row;
}

export function mustGetAttempt(db: RunnerDatabase, attemptID: string): AttemptRow {
  const row = db.sqlite.query<AttemptRow, [string]>(`
    select attempt_id, sequence, kind, status, revision, provider, cost_json,
      provider_invocation_ref, provider_session_id, provider_turn_id
    from run_attempts where attempt_id=?
  `).get(attemptID);
  if (!row) throw new RunCommandValidationError(`Attempt ${attemptID} not found`);
  return row;
}

export function findLifecycleEvents(db: RunnerDatabase, eventID: string, type: string): LifecycleEvent[] {
  return db.sqlite.query<{ created_at: string; id: number; issue_id: number; payload: string; type: string }, [string, string]>(`
    select id, issue_id, type, payload, created_at from issue_events
    where type=? and json_valid(payload) and json_extract(payload, '$.event_id')=?
    order by id asc
  `).all(type, required(eventID, "event_id")).map((row) => ({
    created_at: row.created_at,
    id: row.id,
    payload: { ...parsePayload(row.payload), issue_id: row.issue_id } as LifecyclePayload,
    type: row.type
  }));
}

export function appendLifecycleEvent(
  db: RunnerDatabase,
  issueID: number,
  type: string,
  payload: Record<string, unknown>
): void {
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [issueID, type, JSON.stringify(payload), issueTimestamp()]
  );
}

export function auditPayload(audit: RunTransitionAudit): Record<string, unknown> {
  return {
    actor: audit.actor,
    correlation_id: audit.correlation_id,
    event_id: audit.event_id,
    gate: audit.gate,
    occurred_at: audit.occurred_at,
    reason: audit.reason,
    schema_version: "run-lifecycle-command.v1"
  };
}

export function assertAudit(audit: RunTransitionAudit): void {
  required(audit.event_id, "audit.event_id");
  required(audit.correlation_id, "audit.correlation_id");
  required(audit.occurred_at, "audit.occurred_at");
  required(audit.reason, "audit.reason");
  required(audit.actor.id, "audit.actor.id");
  required(audit.gate.policy_ref, "audit.gate.policy_ref");
  if (!Number.isFinite(Date.parse(audit.occurred_at))) throw new RunCommandValidationError("audit.occurred_at is invalid");
  if (!new Set(["deterministic_policy", "human_approval"]).has(audit.gate.authority)) {
    throw new RunCommandValidationError("audit gate authority is invalid");
  }
}

export function assertFingerprint(event: LifecycleEvent, expected: string): void {
  if (event.payload.fingerprint !== expected) {
    throw new RunCommandConflictError(required(event.payload.event_id, "event_id"));
  }
}

export function commandFingerprint(operation: string, input: unknown): string {
  return createHash("sha256").update(stableJson({ input: fingerprintInput(input), operation })).digest("hex");
}

function fingerprintInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fingerprintInput);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== "occurred_at")
    .map(([key, item]) => [key, fingerprintInput(item)]));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function parsePayload(value: string): LifecyclePayload {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as LifecyclePayload : {};
  } catch {
    return {};
  }
}

export function parsedJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function intentIssueID(event: LifecycleEvent): number {
  const value = (event.payload as LifecyclePayload & { issue_id?: unknown }).issue_id;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new RunCommandValidationError("lifecycle event issue_id is invalid");
  }
  return value;
}

export function required(value: unknown, label: string): string {
  const text = cleanString(value);
  if (text === "") throw new RunCommandValidationError(`${label} is required`);
  return text;
}

export function numeric(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RunCommandValidationError(`${label} must be a non-negative integer`);
  }
  return value;
}

export function assertNonNegative(value: number, label: string): void {
  numeric(value, label);
}

export function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.trim().slice(0, 2000) || "provider operation failed";
}
