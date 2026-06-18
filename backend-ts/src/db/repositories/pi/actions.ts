import type { RunnerDatabase } from "../../database.ts";
import {
  buildFilter,
  cleanString,
  deleteByID,
  getByID,
  integerInput,
  integerValue,
  jsonText,
  listRows,
  now,
  optionalString,
  requiredString,
  requireCreateFields,
  updateByID,
  type PatchInput
} from "./common.ts";
import { redactAuditJsonText, redactAuditText } from "./auditRedaction.ts";

export type PiAction = {
  id: string; project_id: string; issue_id: number; conversation_id: string; action_type: string;
  status: string; risk_level: string; requires_confirmation: number; payload_json: string;
  result_json: string; rationale: string; source: string; gate_decision: string; gate_reason: string;
  requested_changes: string; snoozed_until: string; decided_by: string; approved_by: string;
  delegation_id: string; guardian_decision_id: string; heartbeat_id: string; idempotency_key: string;
  lease_key: string; lease_expires_at: string;
  expected_state_json: string; before_snapshot_json: string; legacy_bypass_reason: string;
  created_at: string; updated_at: string;
};

export type PiActionEvent = {
  id: number; action_id: string; project_id: string; issue_id: number; conversation_id: string;
  event_type: string; actor: string; decision: string; reason: string; payload_json: string;
  result_json: string; error: string; delegation_id: string; heartbeat_id: string; created_at: string;
};

export type PiActionInput = PatchInput<PiAction>;
export type PiActionEventInput = PatchInput<PiActionEvent>;
export type PiActionFilter = { conversationId?: string; issueId?: number; projectId?: string; status?: string };
export type PiActionEventFilter = {
  actionId?: string;
  conversationId?: string;
  delegationId?: string;
  issueId?: number;
  projectId?: string;
};

const TABLE = "pi_actions";
const EVENT_TABLE = "pi_action_events";
const COLUMNS = `id, project_id, issue_id, conversation_id, action_type, status,
  risk_level, requires_confirmation, payload_json, result_json, rationale, source,
  gate_decision, gate_reason, requested_changes, snoozed_until, decided_by, approved_by,
  delegation_id, heartbeat_id, guardian_decision_id, idempotency_key, lease_key,
  lease_expires_at, expected_state_json, before_snapshot_json, legacy_bypass_reason,
  created_at, updated_at`;
const EVENT_COLUMNS = `id, action_id, project_id, issue_id, conversation_id, event_type, actor,
  decision, reason, payload_json, result_json, error, delegation_id, heartbeat_id, created_at`;
const UPDATE_COLUMNS = [
  "project_id", "issue_id", "conversation_id", "action_type", "status", "risk_level",
  "requires_confirmation", "payload_json", "result_json", "rationale", "source",
  "gate_decision", "gate_reason", "requested_changes", "snoozed_until", "decided_by",
  "approved_by", "delegation_id", "heartbeat_id", "guardian_decision_id",
  "idempotency_key", "lease_key", "lease_expires_at", "expected_state_json",
  "before_snapshot_json", "legacy_bypass_reason"
] as const;

export function createPiAction(db: RunnerDatabase, input: PiActionInput): PiAction {
  const record = normalizeCreate(input);
  requireCreateFields(record, ["id", "action_type", "status"]);
  const existing = findExistingPiAction(db, record);
  if (existing) return existing;
  const timestamp = now();
  db.sqlite.run(`insert or ignore into ${TABLE} (${COLUMNS}) values (${placeholders(29)})`, [
    record.id, record.project_id, record.issue_id, record.conversation_id, record.action_type,
    record.status, record.risk_level, record.requires_confirmation, record.payload_json,
    record.result_json, record.rationale, record.source, record.gate_decision, record.gate_reason,
    record.requested_changes, record.snoozed_until, record.decided_by, record.approved_by,
    record.delegation_id, record.heartbeat_id, record.guardian_decision_id,
    record.idempotency_key, record.lease_key, record.lease_expires_at,
    record.expected_state_json, record.before_snapshot_json, record.legacy_bypass_reason,
    timestamp, timestamp
  ]);
  return findExistingPiAction(db, record) ?? mustGetPiAction(db, record.id);
}

export function updatePiAction(db: RunnerDatabase, id: string, input: PiActionInput): PiAction {
  updateByID<PiAction>(db, TABLE, UPDATE_COLUMNS, id, normalizePatch(input));
  return mustGetPiAction(db, id);
}

export function listPiActions(db: RunnerDatabase, filter: PiActionFilter = {}): PiAction[] {
  return listRows(db, TABLE, COLUMNS, mapPiAction, buildFilter([
    ["project_id=?", filter.projectId],
    ["conversation_id=?", filter.conversationId],
    ["issue_id=?", filter.issueId],
    ["status=?", filter.status]
  ], "created_at asc, id asc"));
}

export function getPiAction(db: RunnerDatabase, id: string): PiAction | null {
  return getByID(db, TABLE, COLUMNS, id, mapPiAction);
}

export function deletePiAction(db: RunnerDatabase, id: string): boolean {
  return deleteByID(db, TABLE, id);
}

export function createPiActionEvent(db: RunnerDatabase, input: PiActionEventInput): PiActionEvent {
  const record = normalizeEventCreate(input);
  requireCreateFields(record, ["action_id", "event_type"]);
  db.sqlite.run(`insert into ${EVENT_TABLE} (${eventInsertColumns()}) values (${placeholders(14)})`, [
    record.action_id, record.project_id, record.issue_id, record.conversation_id, record.event_type,
    record.actor, record.decision, record.reason, record.payload_json, record.result_json,
    record.error, record.delegation_id, record.heartbeat_id, now()
  ]);
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  return mustGetPiActionEvent(db, row?.id ?? 0);
}

export function listPiActionEvents(db: RunnerDatabase, filter: PiActionEventFilter = {}): PiActionEvent[] {
  return listRows(db, EVENT_TABLE, EVENT_COLUMNS, mapPiActionEvent, buildFilter([
    ["action_id=?", filter.actionId],
    ["project_id=?", filter.projectId],
    ["conversation_id=?", filter.conversationId],
    ["issue_id=?", filter.issueId],
    ["delegation_id=?", filter.delegationId]
  ], "id asc"));
}

function mustGetPiAction(db: RunnerDatabase, id: string): PiAction {
  const record = getPiAction(db, id);
  if (!record) throw new Error("PI action missing after write");
  return record;
}

function findExistingPiAction(db: RunnerDatabase, record: PiAction): PiAction | null {
  if (record.idempotency_key === "") return getPiAction(db, record.id);
  const row = db.sqlite.query<Record<string, unknown>, [string, string]>(
    `select ${COLUMNS} from ${TABLE} where id=? or idempotency_key=? order by created_at asc, id asc limit 1`
  ).get(record.id, record.idempotency_key);
  return row ? mapPiAction(row) : null;
}

function mustGetPiActionEvent(db: RunnerDatabase, id: number): PiActionEvent {
  const row = db.sqlite.query<Record<string, unknown>, [number]>(
    `select ${EVENT_COLUMNS} from ${EVENT_TABLE} where id=?`
  ).get(id);
  if (!row) throw new Error("PI action event missing after write");
  return mapPiActionEvent(row);
}

function normalizeCreate(input: PiActionInput): PiAction {
  return {
    id: cleanString(input.id), project_id: cleanString(input.project_id),
    issue_id: integerInput(input.issue_id), conversation_id: cleanString(input.conversation_id),
    action_type: cleanString(input.action_type), status: cleanString(input.status),
    risk_level: cleanString(input.risk_level) || "low",
    requires_confirmation: integerInput(input.requires_confirmation),
    payload_json: jsonText(input.payload_json, "{}"), result_json: jsonText(input.result_json, "{}"),
    rationale: cleanString(input.rationale), source: cleanString(input.source),
    gate_decision: cleanString(input.gate_decision), gate_reason: cleanString(input.gate_reason),
    requested_changes: cleanString(input.requested_changes), snoozed_until: cleanString(input.snoozed_until),
    decided_by: cleanString(input.decided_by), approved_by: cleanString(input.approved_by),
    delegation_id: cleanString(input.delegation_id), guardian_decision_id: cleanString(input.guardian_decision_id),
    heartbeat_id: cleanString(input.heartbeat_id), idempotency_key: cleanString(input.idempotency_key),
    lease_key: cleanString(input.lease_key), lease_expires_at: cleanString(input.lease_expires_at),
    expected_state_json: jsonText(input.expected_state_json, "{}"),
    before_snapshot_json: jsonText(input.before_snapshot_json, "{}"),
    legacy_bypass_reason: cleanString(input.legacy_bypass_reason) ||
      (cleanString(input.guardian_decision_id) === "" ? "legacy_direct_action" : ""),
    created_at: "", updated_at: ""
  };
}

function normalizePatch(input: PiActionInput): PiActionInput {
  return {
    ...input,
    before_snapshot_json: input.before_snapshot_json === undefined ? undefined : jsonText(input.before_snapshot_json, "{}"),
    expected_state_json: input.expected_state_json === undefined ? undefined : jsonText(input.expected_state_json, "{}"),
    payload_json: input.payload_json === undefined ? undefined : jsonText(input.payload_json, "{}"),
    result_json: input.result_json === undefined ? undefined : jsonText(input.result_json, "{}")
  };
}

function normalizeEventCreate(input: PiActionEventInput): PiActionEvent {
  return {
    id: 0, action_id: cleanString(input.action_id), project_id: cleanString(input.project_id),
    issue_id: integerInput(input.issue_id), conversation_id: cleanString(input.conversation_id),
    event_type: cleanString(input.event_type), actor: cleanString(input.actor),
    decision: cleanString(input.decision), reason: redactAuditText(cleanString(input.reason)),
    payload_json: redactAuditJsonText(jsonText(input.payload_json, "{}")),
    result_json: redactAuditJsonText(jsonText(input.result_json, "{}")),
    error: redactAuditText(cleanString(input.error)), delegation_id: cleanString(input.delegation_id),
    heartbeat_id: cleanString(input.heartbeat_id), created_at: ""
  };
}

function mapPiAction(row: Record<string, unknown>): PiAction {
  return {
    id: requiredString(row.id, "pi_actions.id"), project_id: optionalString(row.project_id),
    issue_id: integerValue(row.issue_id, "pi_actions.issue_id"),
    conversation_id: optionalString(row.conversation_id),
    action_type: requiredString(row.action_type, "pi_actions.action_type"),
    status: requiredString(row.status, "pi_actions.status"),
    risk_level: requiredString(row.risk_level, "pi_actions.risk_level"),
    requires_confirmation: integerValue(row.requires_confirmation, "pi_actions.requires_confirmation"),
    payload_json: optionalString(row.payload_json), result_json: optionalString(row.result_json),
    rationale: optionalString(row.rationale), source: optionalString(row.source),
    gate_decision: optionalString(row.gate_decision), gate_reason: optionalString(row.gate_reason),
    requested_changes: optionalString(row.requested_changes), snoozed_until: optionalString(row.snoozed_until),
    decided_by: optionalString(row.decided_by), approved_by: optionalString(row.approved_by),
    delegation_id: optionalString(row.delegation_id), guardian_decision_id: optionalString(row.guardian_decision_id),
    heartbeat_id: optionalString(row.heartbeat_id), idempotency_key: optionalString(row.idempotency_key),
    lease_key: optionalString(row.lease_key), lease_expires_at: optionalString(row.lease_expires_at),
    expected_state_json: optionalString(row.expected_state_json) || "{}",
    before_snapshot_json: optionalString(row.before_snapshot_json) || "{}",
    legacy_bypass_reason: optionalString(row.legacy_bypass_reason),
    created_at: requiredString(row.created_at, "pi_actions.created_at"),
    updated_at: requiredString(row.updated_at, "pi_actions.updated_at")
  };
}

function mapPiActionEvent(row: Record<string, unknown>): PiActionEvent {
  return {
    id: integerValue(row.id, "pi_action_events.id"),
    action_id: requiredString(row.action_id, "pi_action_events.action_id"),
    project_id: optionalString(row.project_id), issue_id: integerValue(row.issue_id, "pi_action_events.issue_id"),
    conversation_id: optionalString(row.conversation_id),
    event_type: requiredString(row.event_type, "pi_action_events.event_type"),
    actor: optionalString(row.actor), decision: optionalString(row.decision), reason: redactAuditText(optionalString(row.reason)),
    payload_json: redactAuditJsonText(optionalString(row.payload_json) || "{}"),
    result_json: redactAuditJsonText(optionalString(row.result_json) || "{}"),
    error: redactAuditText(optionalString(row.error)), delegation_id: optionalString(row.delegation_id),
    heartbeat_id: optionalString(row.heartbeat_id),
    created_at: requiredString(row.created_at, "pi_action_events.created_at")
  };
}

function eventInsertColumns(): string {
  return `action_id, project_id, issue_id, conversation_id, event_type, actor, decision,
    reason, payload_json, result_json, error, delegation_id, heartbeat_id, created_at`;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
