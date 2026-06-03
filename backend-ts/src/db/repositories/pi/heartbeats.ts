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
  updateByID,
  type PatchInput
} from "./common.ts";

export type PiHeartbeatRun = {
  id: string; kind: string; project_id: string; delegation_id: string; status: string;
  trigger: string; started_at: string; finished_at: string; next_tick_at: string;
  error: string; signals_json: string; policy_json: string; action_plan_json: string;
  result_json: string; created_at: string; updated_at: string;
};
export type PiHeartbeatEvent = {
  id: number; heartbeat_id: string; project_id: string; delegation_id: string;
  event_type: string; message: string; payload_json: string; error: string; created_at: string;
};
export type PiHeartbeatControl = {
  scope_type: string; scope_id: string; paused: number; reason: string; updated_at: string;
};
export type PiDelegation = {
  id: string; project_id: string; title: string; status: string; intent_json: string;
  authorization_json: string; scope_json: string; starts_at: string; expires_at: string;
  allowed_actions_json: string; forbidden_actions_json: string; audit_source: string;
  next_heartbeat_at: string; last_heartbeat_at: string;
  created_at: string; updated_at: string;
};

export type PiHeartbeatRunInput = PatchInput<PiHeartbeatRun>;
export type PiHeartbeatEventInput = PatchInput<PiHeartbeatEvent>;
export type PiHeartbeatFilter = { delegationId?: string; heartbeatId?: string; kind?: string; projectId?: string; status?: string };
export type PiHeartbeatControlScope = { reason?: string; scopeId?: string; scopeType: string };

const RUN_TABLE = "pi_heartbeat_runs";
const EVENT_TABLE = "pi_heartbeat_events";
const CONTROL_TABLE = "pi_heartbeat_controls";
const DELEGATION_TABLE = "pi_delegations";
const RUN_COLUMNS = `id, kind, project_id, delegation_id, status, trigger, started_at,
  finished_at, next_tick_at, error, signals_json, policy_json, action_plan_json,
  result_json, created_at, updated_at`;
const EVENT_COLUMNS = `id, heartbeat_id, project_id, delegation_id, event_type,
  message, payload_json, error, created_at`;
const CONTROL_COLUMNS = `scope_type, scope_id, paused, reason, updated_at`;
const DELEGATION_COLUMNS = `id, project_id, title, status, intent_json, authorization_json,
  scope_json, starts_at, expires_at, allowed_actions_json, forbidden_actions_json,
  audit_source, next_heartbeat_at, last_heartbeat_at, created_at, updated_at`;
const RUN_UPDATE_COLUMNS = [
  "kind", "project_id", "delegation_id", "status", "trigger", "started_at", "finished_at",
  "next_tick_at", "error", "signals_json", "policy_json", "action_plan_json", "result_json"
] as const;

export function createPiHeartbeatRun(db: RunnerDatabase, input: PiHeartbeatRunInput): PiHeartbeatRun {
  const record = normalizeRunCreate(input);
  db.sqlite.run(`insert into ${RUN_TABLE} (${RUN_COLUMNS}) values (${placeholders(16)})`, [
    record.id, record.kind, record.project_id, record.delegation_id, record.status,
    record.trigger, record.started_at, record.finished_at, record.next_tick_at, record.error,
    record.signals_json, record.policy_json, record.action_plan_json, record.result_json,
    record.created_at, record.updated_at
  ]);
  return mustGetPiHeartbeatRun(db, record.id);
}

export function updatePiHeartbeatRun(db: RunnerDatabase, id: string, input: PiHeartbeatRunInput): PiHeartbeatRun {
  updateByID<PiHeartbeatRun>(db, RUN_TABLE, RUN_UPDATE_COLUMNS, id, normalizeRunPatch(input));
  return mustGetPiHeartbeatRun(db, id);
}

export function getPiHeartbeatRun(db: RunnerDatabase, id: string): PiHeartbeatRun | null {
  return getByID(db, RUN_TABLE, RUN_COLUMNS, id, mapHeartbeatRun);
}

export function listPiHeartbeatRuns(db: RunnerDatabase, filter: PiHeartbeatFilter = {}): PiHeartbeatRun[] {
  return listRows(db, RUN_TABLE, RUN_COLUMNS, mapHeartbeatRun, buildFilter([
    ["id=?", filter.heartbeatId], ["kind=?", filter.kind], ["project_id=?", filter.projectId],
    ["delegation_id=?", filter.delegationId], ["status=?", filter.status]
  ], "started_at desc, id desc"));
}

export function createPiHeartbeatEvent(db: RunnerDatabase, input: PiHeartbeatEventInput): PiHeartbeatEvent {
  const record = normalizeEventCreate(input);
  db.sqlite.run(`insert into ${EVENT_TABLE} (${eventInsertColumns()}) values (${placeholders(8)})`, [
    record.heartbeat_id, record.project_id, record.delegation_id, record.event_type,
    record.message, record.payload_json, record.error, record.created_at
  ]);
  return mustGetPiHeartbeatEvent(db, lastInsertID(db));
}

export function listPiHeartbeatEvents(db: RunnerDatabase, filter: PiHeartbeatFilter = {}): PiHeartbeatEvent[] {
  return listRows(db, EVENT_TABLE, EVENT_COLUMNS, mapHeartbeatEvent, buildFilter([
    ["heartbeat_id=?", filter.heartbeatId], ["project_id=?", filter.projectId],
    ["delegation_id=?", filter.delegationId]
  ], "id asc"));
}

export function pausePiHeartbeat(db: RunnerDatabase, input: PiHeartbeatControlScope): PiHeartbeatControl {
  return writeHeartbeatControl(db, input, 1);
}

export function resumePiHeartbeat(db: RunnerDatabase, input: PiHeartbeatControlScope): PiHeartbeatControl {
  return writeHeartbeatControl(db, input, 0);
}

export function diagnosePiHeartbeat(db: RunnerDatabase, input: Omit<PiHeartbeatControlScope, "reason">) {
  const scope = normalizeScope(input);
  const control = getHeartbeatControl(db, scope);
  const recentRuns = listPiHeartbeatRuns(db, scopeFilter(scope)).slice(0, 10);
  const paused = control?.paused === 1;
  return {
    active: !paused,
    control: control ? { ...control, paused: control.paused === 1 } : null,
    last_error: recentRuns.find((run) => run.status === "failed" && run.error !== "")?.error ?? "",
    paused,
    recent_events: listPiHeartbeatEvents(db, scopeFilter(scope)).slice(-20),
    recent_runs: recentRuns,
    status: paused ? "paused" : "active"
  };
}

export function isPiHeartbeatPaused(db: RunnerDatabase, input: Omit<PiHeartbeatControlScope, "reason">): boolean {
  return getHeartbeatControl(db, normalizeScope(input))?.paused === 1;
}

export function listActivePiDelegations(db: RunnerDatabase, nowText: string): PiDelegation[] {
  return db.sqlite.query<Record<string, unknown>, [string, string]>(`
    select ${DELEGATION_COLUMNS} from ${DELEGATION_TABLE}
    where status=? and (next_heartbeat_at='' or next_heartbeat_at<=?)
      and not exists (
        select 1 from ${CONTROL_TABLE}
        where scope_type='project' and scope_id=${DELEGATION_TABLE}.project_id and paused=1
      )
    order by next_heartbeat_at asc, created_at asc, id asc
  `).all("active", nowText).map(mapDelegation);
}

export function updatePiDelegationHeartbeat(db: RunnerDatabase, id: string, lastAt: string, nextAt: string): void {
  db.sqlite.run(`update ${DELEGATION_TABLE} set last_heartbeat_at=?, next_heartbeat_at=?, updated_at=? where id=?`,
    [lastAt, nextAt, now(), id.trim()]);
}

function writeHeartbeatControl(db: RunnerDatabase, input: PiHeartbeatControlScope, paused: number): PiHeartbeatControl {
  const scope = normalizeScope(input);
  const timestamp = now();
  db.sqlite.run(`insert into ${CONTROL_TABLE} (${CONTROL_COLUMNS}) values (?, ?, ?, ?, ?)
    on conflict(scope_type, scope_id) do update set paused=excluded.paused,
      reason=excluded.reason, updated_at=excluded.updated_at`,
    [scope.scopeType, scope.scopeId, paused, cleanString(input.reason), timestamp]);
  return getHeartbeatControl(db, scope) ?? missingControl(scope);
}

function getHeartbeatControl(db: RunnerDatabase, scope: ReturnType<typeof normalizeScope>): PiHeartbeatControl | null {
  const row = db.sqlite.query<Record<string, unknown>, [string, string]>(
    `select ${CONTROL_COLUMNS} from ${CONTROL_TABLE} where scope_type=? and scope_id=?`
  ).get(scope.scopeType, scope.scopeId);
  return row ? mapControl(row) : null;
}

function normalizeRunCreate(input: PiHeartbeatRunInput): PiHeartbeatRun {
  const timestamp = now();
  return {
    id: cleanString(input.id) || crypto.randomUUID(),
    kind: cleanString(input.kind) || "project",
    project_id: cleanString(input.project_id),
    delegation_id: cleanString(input.delegation_id),
    status: cleanString(input.status) || "running",
    trigger: cleanString(input.trigger),
    started_at: cleanString(input.started_at) || timestamp,
    finished_at: cleanString(input.finished_at),
    next_tick_at: cleanString(input.next_tick_at),
    error: cleanString(input.error),
    signals_json: jsonText(input.signals_json, "{}"),
    policy_json: jsonText(input.policy_json, "{}"),
    action_plan_json: jsonText(input.action_plan_json, "[]"),
    result_json: jsonText(input.result_json, "{}"),
    created_at: timestamp,
    updated_at: timestamp
  };
}

function normalizeRunPatch(input: PiHeartbeatRunInput): PiHeartbeatRunInput {
  return {
    ...input,
    action_plan_json: input.action_plan_json === undefined ? undefined : jsonText(input.action_plan_json, "[]"),
    policy_json: input.policy_json === undefined ? undefined : jsonText(input.policy_json, "{}"),
    result_json: input.result_json === undefined ? undefined : jsonText(input.result_json, "{}"),
    signals_json: input.signals_json === undefined ? undefined : jsonText(input.signals_json, "{}")
  };
}

function normalizeEventCreate(input: PiHeartbeatEventInput): PiHeartbeatEvent {
  return {
    id: 0, heartbeat_id: requiredString(input.heartbeat_id, "heartbeat_id"),
    project_id: cleanString(input.project_id), delegation_id: cleanString(input.delegation_id),
    event_type: requiredString(input.event_type, "event_type"), message: cleanString(input.message),
    payload_json: jsonText(input.payload_json, "{}"), error: cleanString(input.error), created_at: now()
  };
}

function mapHeartbeatRun(row: Record<string, unknown>): PiHeartbeatRun {
  return {
    id: requiredString(row.id, "pi_heartbeat_runs.id"), kind: requiredString(row.kind, "pi_heartbeat_runs.kind"),
    project_id: optionalString(row.project_id), delegation_id: optionalString(row.delegation_id),
    status: requiredString(row.status, "pi_heartbeat_runs.status"), trigger: optionalString(row.trigger),
    started_at: requiredString(row.started_at, "pi_heartbeat_runs.started_at"),
    finished_at: optionalString(row.finished_at), next_tick_at: optionalString(row.next_tick_at),
    error: optionalString(row.error), signals_json: optionalString(row.signals_json),
    policy_json: optionalString(row.policy_json), action_plan_json: optionalString(row.action_plan_json),
    result_json: optionalString(row.result_json), created_at: requiredString(row.created_at, "pi_heartbeat_runs.created_at"),
    updated_at: requiredString(row.updated_at, "pi_heartbeat_runs.updated_at")
  };
}

function mapHeartbeatEvent(row: Record<string, unknown>): PiHeartbeatEvent {
  return {
    id: integerValue(row.id, "pi_heartbeat_events.id"), heartbeat_id: requiredString(row.heartbeat_id, "heartbeat_id"),
    project_id: optionalString(row.project_id), delegation_id: optionalString(row.delegation_id),
    event_type: requiredString(row.event_type, "event_type"), message: optionalString(row.message),
    payload_json: optionalString(row.payload_json), error: optionalString(row.error),
    created_at: requiredString(row.created_at, "created_at")
  };
}

function mapControl(row: Record<string, unknown>): PiHeartbeatControl {
  return {
    scope_type: requiredString(row.scope_type, "scope_type"), scope_id: optionalString(row.scope_id),
    paused: integerValue(row.paused, "paused"), reason: optionalString(row.reason),
    updated_at: requiredString(row.updated_at, "updated_at")
  };
}

function mapDelegation(row: Record<string, unknown>): PiDelegation {
  return {
    id: requiredString(row.id, "pi_delegations.id"), project_id: optionalString(row.project_id),
    title: optionalString(row.title), status: requiredString(row.status, "pi_delegations.status"),
    intent_json: optionalString(row.intent_json) || "{}", authorization_json: optionalString(row.authorization_json) || "{}",
    scope_json: optionalString(row.scope_json) || "{}", starts_at: optionalString(row.starts_at),
    expires_at: optionalString(row.expires_at), allowed_actions_json: optionalString(row.allowed_actions_json) || "[]",
    forbidden_actions_json: optionalString(row.forbidden_actions_json) || "[]",
    audit_source: optionalString(row.audit_source),
    next_heartbeat_at: optionalString(row.next_heartbeat_at), last_heartbeat_at: optionalString(row.last_heartbeat_at),
    created_at: requiredString(row.created_at, "created_at"), updated_at: requiredString(row.updated_at, "updated_at")
  };
}

function normalizeScope(input: Omit<PiHeartbeatControlScope, "reason">): { scopeId: string; scopeType: string } {
  return { scopeId: cleanString(input.scopeId), scopeType: requiredString(input.scopeType, "scopeType") };
}

function scopeFilter(scope: ReturnType<typeof normalizeScope>): PiHeartbeatFilter {
  if (scope.scopeType === "project") return { projectId: scope.scopeId };
  if (scope.scopeType === "delegation") return { delegationId: scope.scopeId };
  return { kind: scope.scopeType };
}

function mustGetPiHeartbeatRun(db: RunnerDatabase, id: string): PiHeartbeatRun {
  const run = getPiHeartbeatRun(db, id);
  if (!run) throw new Error("PI heartbeat run missing after write");
  return run;
}

function mustGetPiHeartbeatEvent(db: RunnerDatabase, id: number): PiHeartbeatEvent {
  const row = db.sqlite.query<Record<string, unknown>, [number]>(
    `select ${EVENT_COLUMNS} from ${EVENT_TABLE} where id=?`
  ).get(id);
  if (!row) throw new Error("PI heartbeat event missing after write");
  return mapHeartbeatEvent(row);
}

function missingControl(scope: ReturnType<typeof normalizeScope>): PiHeartbeatControl {
  return { scope_type: scope.scopeType, scope_id: scope.scopeId, paused: 0, reason: "", updated_at: "" };
}

function eventInsertColumns(): string {
  return `heartbeat_id, project_id, delegation_id, event_type, message, payload_json, error, created_at`;
}

function lastInsertID(db: RunnerDatabase): number {
  return integerInput(db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id);
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
