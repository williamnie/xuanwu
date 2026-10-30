import type { RunnerDatabase } from "../../database.ts";
import {
  buildFilter,
  cleanString,
  deleteByID,
  getByID,
  listRows,
  now,
  requireCreateFields,
  updateByID
} from "./common.ts";
import { placeholders } from "../../sql.ts";
import {
  type PiActionInput,
  type PiAction,
  normalizeCreate,
  TABLE,
  COLUMNS,
  UPDATE_COLUMNS,
  normalizePatch,
  type PiActionFilter,
  mapPiAction,
  type PiActionEventInput,
  type PiActionEvent,
  normalizeEventCreate,
  EVENT_TABLE,
  eventInsertColumns,
  type PiActionEventFilter,
  EVENT_COLUMNS,
  mapPiActionEvent
} from "./actionsModel.ts";

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

export function getPiActionByIdempotencyKey(db: RunnerDatabase, idempotencyKey: string): PiAction | null {
  const key = cleanString(idempotencyKey);
  if (key === "") return null;
  const row = db.sqlite.query<Record<string, unknown>, [string]>(
    `select ${COLUMNS} from ${TABLE} where idempotency_key=? and idempotency_key<>'' order by created_at asc, id asc limit 1`
  ).get(key);
  return row ? mapPiAction(row) : null;
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
    ["event_type=?", filter.eventType],
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
    `select ${COLUMNS} from ${TABLE} where id=? or (idempotency_key=? and idempotency_key<>'') order by created_at asc, id asc limit 1`
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

export type { PiAction } from "./actionsModel.ts";
export type { PiActionEvent } from "./actionsModel.ts";
export type { PiActionInput } from "./actionsModel.ts";
export type { PendingPiActionNotification } from "./actionsModel.ts";
export type { PiActionFilter } from "./actionsModel.ts";
export { listPiActivityActions } from "./actionsActivity.ts";
export { latestCompletedEnqueueAction } from "./actionsActivity.ts";
export { listPiActivityActionEvents } from "./actionsActivity.ts";
export { listRecentAttentionPiActions } from "./actionsActivity.ts";
export { listActiveAttentionPiActions } from "./actionsActivity.ts";
export { listPendingPiActionNotifications } from "./actionsActivity.ts";
export { listPiActionsReferencingIssue } from "./actionsActivity.ts";
