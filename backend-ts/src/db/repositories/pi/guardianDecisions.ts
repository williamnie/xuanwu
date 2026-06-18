import type { RunnerDatabase } from "../../database.ts";
import {
  buildFilter,
  cleanString,
  getByID,
  integerInput,
  integerValue,
  jsonText,
  listRows,
  now,
  optionalString,
  requiredString,
  type PatchInput
} from "./common.ts";
import { redactAuditJsonText, redactAuditText } from "./auditRedaction.ts";

export type PiGuardianDecision = {
  actions_json: string;
  authority: string;
  conversation_id: string;
  cooldown_until: string;
  created_at: string;
  decision: string;
  decision_kind: string;
  evidence_json: string;
  id: string;
  idempotency_key: string;
  issue_id: number;
  lease_expires_at: string;
  lease_owner: string;
  pi_session_id: string;
  project_id: string;
  rationale: string;
  raw_pi_text_ref: string;
  requires_user: number;
  risk_level: string;
  run_group_id: string;
  source_event_id: string;
  source_event_sequence_id: number;
  state: string;
  updated_at: string;
};

export type PiGuardianDecisionInput = PatchInput<PiGuardianDecision>;
export type PiGuardianDecisionFilter = {
  decisionKind?: string;
  issueId?: number;
  projectId?: string;
  state?: string;
};
export type PiGuardianDecisionState =
  "approved" | "completed" | "deferred" | "executing" | "failed" | "proposed" | "skipped" | "superseded";
export type PiGuardianDecisionTransitionInput = {
  cooldownUntil?: string;
  from?: PiGuardianDecisionState;
  rationale?: string;
  to: PiGuardianDecisionState;
};
export type PiGuardianDecisionLeaseInput = {
  now?: Date;
  owner: string;
  ttlMs: number;
};

type SQLValue = string | number;
const TABLE = "pi_guardian_decisions";
const COLUMNS = `id, idempotency_key, source_event_id, source_event_sequence_id,
  decision_kind, authority, project_id, issue_id, run_group_id, conversation_id,
  decision, risk_level, requires_user, rationale, evidence_json, actions_json,
  state, lease_owner, lease_expires_at, cooldown_until, pi_session_id,
  raw_pi_text_ref, created_at, updated_at`;
const TERMINAL_STATES = new Set(["completed", "failed", "skipped", "superseded"]);
const VALID_STATES = new Set(["proposed", "approved", "deferred", "executing", ...TERMINAL_STATES]);
const CLEAR_LEASE_STATES = new Set(["completed", "failed", "skipped", "superseded"]);

export function upsertPiGuardianDecision(
  db: RunnerDatabase,
  input: PiGuardianDecisionInput
): PiGuardianDecision {
  const record = normalizeCreate(input);
  const timestamp = now();
  db.sqlite.run(`insert into ${TABLE} (${COLUMNS}) values (${placeholders(24)})
    on conflict(idempotency_key) do update set
      source_event_id=coalesce(nullif(excluded.source_event_id, ''), ${TABLE}.source_event_id),
      source_event_sequence_id=case when excluded.source_event_sequence_id > 0
        then excluded.source_event_sequence_id else ${TABLE}.source_event_sequence_id end,
      decision_kind=coalesce(nullif(excluded.decision_kind, ''), ${TABLE}.decision_kind),
      authority=coalesce(nullif(excluded.authority, ''), ${TABLE}.authority),
      project_id=coalesce(nullif(excluded.project_id, ''), ${TABLE}.project_id),
      issue_id=case when excluded.issue_id > 0 then excluded.issue_id else ${TABLE}.issue_id end,
      run_group_id=coalesce(nullif(excluded.run_group_id, ''), ${TABLE}.run_group_id),
      conversation_id=coalesce(nullif(excluded.conversation_id, ''), ${TABLE}.conversation_id),
      decision=coalesce(nullif(excluded.decision, ''), ${TABLE}.decision),
      risk_level=coalesce(nullif(excluded.risk_level, ''), ${TABLE}.risk_level),
      requires_user=excluded.requires_user,
      rationale=coalesce(nullif(excluded.rationale, ''), ${TABLE}.rationale),
      evidence_json=case when excluded.evidence_json <> '[]' then excluded.evidence_json else ${TABLE}.evidence_json end,
      actions_json=case when excluded.actions_json <> '[]' then excluded.actions_json else ${TABLE}.actions_json end,
      updated_at=excluded.updated_at`, [
    record.id, record.idempotency_key, record.source_event_id, record.source_event_sequence_id,
    record.decision_kind, record.authority, record.project_id, record.issue_id,
    record.run_group_id, record.conversation_id, record.decision, record.risk_level,
    record.requires_user, record.rationale, record.evidence_json, record.actions_json,
    record.state, record.lease_owner, record.lease_expires_at, record.cooldown_until,
    record.pi_session_id, record.raw_pi_text_ref, timestamp, timestamp
  ]);
  return mustGetPiGuardianDecision(db, record);
}

export function getPiGuardianDecision(db: RunnerDatabase, id: string): PiGuardianDecision | null {
  return getByID(db, TABLE, COLUMNS, id, mapDecision);
}

export function transitionPiGuardianDecisionState(
  db: RunnerDatabase,
  id: string,
  input: PiGuardianDecisionTransitionInput
): PiGuardianDecision {
  const current = requirePiGuardianDecision(db, id);
  if (input.from && current.state !== input.from) {
    throw new Error(`expected state ${input.from} for PI guardian decision ${current.id}, got ${current.state}`);
  }
  assertTransition(current, input.to);
  if (current.state === input.to) return current;
  const shouldClearLease = CLEAR_LEASE_STATES.has(input.to);
  db.sqlite.run(`update ${TABLE} set state=?, lease_owner=?, lease_expires_at=?,
    cooldown_until=?, rationale=?, updated_at=? where id=?`, [
    input.to,
    shouldClearLease ? "" : current.lease_owner,
    shouldClearLease ? "" : current.lease_expires_at,
    cleanString(input.cooldownUntil) || current.cooldown_until,
    cleanString(input.rationale) === "" ? current.rationale : redactAuditText(cleanString(input.rationale)),
    now(),
    current.id
  ]);
  return requirePiGuardianDecision(db, current.id);
}

export function claimPiGuardianDecisionLease(
  db: RunnerDatabase,
  id: string,
  input: PiGuardianDecisionLeaseInput
): PiGuardianDecision | null {
  const owner = requiredString(input.owner, "owner");
  if (!Number.isInteger(input.ttlMs) || input.ttlMs <= 0) throw new Error("ttlMs must be a positive integer");
  const key = requiredString(id, "id");
  const nowDate = input.now ?? new Date();
  const timestamp = iso(nowDate);
  const expiresAt = iso(new Date(nowDate.getTime() + input.ttlMs));
  const result = db.sqlite.run(`update ${TABLE} set lease_owner=?, lease_expires_at=?, updated_at=?
    where id=? and state in ('proposed', 'approved', 'deferred', 'executing')
      and (cooldown_until='' or cooldown_until<=?)
      and (lease_owner='' or lease_owner=? or lease_expires_at='' or lease_expires_at<=?)`, [
    owner, expiresAt, timestamp, key, timestamp, owner, timestamp
  ]);
  return result.changes > 0 ? requirePiGuardianDecision(db, key) : null;
}

export function listPiGuardianDecisions(
  db: RunnerDatabase,
  filter: PiGuardianDecisionFilter = {}
): PiGuardianDecision[] {
  return listRows(db, TABLE, COLUMNS, mapDecision, buildFilter([
    ["project_id=?", filter.projectId],
    ["issue_id=?", filter.issueId],
    ["decision_kind=?", filter.decisionKind],
    ["state=?", filter.state]
  ], "created_at asc, id asc"));
}

function normalizeCreate(input: PiGuardianDecisionInput): PiGuardianDecision {
  const idempotencyKey = requiredString(input.idempotency_key, "idempotency_key");
  const decisionKind = requiredString(input.decision_kind, "decision_kind");
  const state = decisionState(cleanString(input.state) || "proposed");
  return {
    actions_json: jsonArrayText(input.actions_json),
    authority: cleanString(input.authority) || "policy",
    conversation_id: cleanString(input.conversation_id),
    cooldown_until: cleanString(input.cooldown_until),
    created_at: "",
    decision: requiredString(input.decision, "decision"),
    decision_kind: decisionKind,
    evidence_json: jsonArrayText(input.evidence_json),
    id: cleanString(input.id) || idempotencyKey,
    idempotency_key: idempotencyKey,
    issue_id: integerInput(input.issue_id),
    lease_expires_at: cleanString(input.lease_expires_at),
    lease_owner: cleanString(input.lease_owner),
    pi_session_id: cleanString(input.pi_session_id),
    project_id: cleanString(input.project_id),
    rationale: redactAuditText(cleanString(input.rationale)),
    raw_pi_text_ref: piTextReference(input.raw_pi_text_ref),
    requires_user: integerInput(input.requires_user),
    risk_level: cleanString(input.risk_level) || "low",
    run_group_id: cleanString(input.run_group_id),
    source_event_id: cleanString(input.source_event_id),
    source_event_sequence_id: integerInput(input.source_event_sequence_id),
    state,
    updated_at: ""
  };
}

function mapDecision(row: Record<string, unknown>): PiGuardianDecision {
  return {
    actions_json: redactAuditJsonText(optionalString(row.actions_json) || "[]"),
    authority: optionalString(row.authority) || "policy",
    conversation_id: optionalString(row.conversation_id),
    cooldown_until: optionalString(row.cooldown_until),
    created_at: requiredString(row.created_at, `${TABLE}.created_at`),
    decision: requiredString(row.decision, `${TABLE}.decision`),
    decision_kind: requiredString(row.decision_kind, `${TABLE}.decision_kind`),
    evidence_json: redactAuditJsonText(optionalString(row.evidence_json) || "[]"),
    id: requiredString(row.id, `${TABLE}.id`),
    idempotency_key: requiredString(row.idempotency_key, `${TABLE}.idempotency_key`),
    issue_id: integerValue(row.issue_id, `${TABLE}.issue_id`),
    lease_expires_at: optionalString(row.lease_expires_at),
    lease_owner: optionalString(row.lease_owner),
    pi_session_id: optionalString(row.pi_session_id),
    project_id: optionalString(row.project_id),
    rationale: redactAuditText(optionalString(row.rationale)),
    raw_pi_text_ref: piTextReference(row.raw_pi_text_ref),
    requires_user: integerValue(row.requires_user, `${TABLE}.requires_user`),
    risk_level: optionalString(row.risk_level) || "low",
    run_group_id: optionalString(row.run_group_id),
    source_event_id: optionalString(row.source_event_id),
    source_event_sequence_id: integerValue(row.source_event_sequence_id, `${TABLE}.source_event_sequence_id`),
    state: optionalString(row.state) || "proposed",
    updated_at: requiredString(row.updated_at, `${TABLE}.updated_at`)
  };
}

function mustGetPiGuardianDecision(
  db: RunnerDatabase,
  record: PiGuardianDecision
): PiGuardianDecision {
  const row = db.sqlite.query<Record<string, unknown>, [string, string]>(
    `select ${COLUMNS} from ${TABLE} where id=? or idempotency_key=? limit 1`
  ).get(record.id, record.idempotency_key);
  if (!row) throw new Error("PI guardian decision missing after write");
  return mapDecision(row);
}

function requirePiGuardianDecision(db: RunnerDatabase, id: string): PiGuardianDecision {
  const decision = getPiGuardianDecision(db, id);
  if (!decision) throw new Error(`PI guardian decision ${cleanString(id)} not found`);
  return decision;
}

function assertTransition(current: PiGuardianDecision, to: PiGuardianDecisionState): void {
  const from = decisionState(current.state);
  if (from === to) return;
  if (TERMINAL_STATES.has(from)) {
    throw new Error(`cannot transition PI guardian decision ${current.id} from ${from} to ${to}`);
  }
  const allowed = allowedNextStates(from);
  if (allowed.includes(to)) return;
  throw new Error(`cannot transition PI guardian decision ${current.id} from ${from} to ${to}`);
}

function allowedNextStates(from: PiGuardianDecisionState): PiGuardianDecisionState[] {
  if (from === "proposed") return ["approved", "deferred", "executing", "completed", "failed", "skipped", "superseded"];
  if (from === "deferred") return ["approved", "executing", "failed", "skipped", "superseded"];
  return ["executing", "completed", "failed", "skipped", "superseded"];
}

function decisionState(value: string): PiGuardianDecisionState {
  if (VALID_STATES.has(value)) return value as PiGuardianDecisionState;
  throw new Error(`invalid PI guardian decision state ${value}`);
}

function piTextReference(value: unknown): string {
  const text = cleanString(value);
  if (text === "") return "";
  const redacted = redactAuditText(text);
  if (redacted !== text || /\s/.test(text)) return "";
  return /^[a-z][a-z0-9_.-]*:[^\s]+$/i.test(text) ? text : "";
}

function iso(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function jsonArrayText(value: unknown): string {
  if (typeof value === "string") return redactAuditJsonText(jsonText(value, "[]"));
  return redactAuditJsonText(JSON.stringify(value ?? []));
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
