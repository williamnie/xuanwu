import type { RunnerDatabase } from "../../database.ts";
import {
  buildFilter,
  cleanString,
  getByID,
  jsonText,
  listRows,
  now,
  optionalString,
  requiredString,
  updateByID,
  type PatchInput
} from "./common.ts";
import type { PiDelegation } from "./heartbeats.ts";

export type PiDelegationInput = PatchInput<PiDelegation>;
export type PiDelegationFilter = { projectId?: string; status?: string };

const TABLE = "pi_delegations";
const COLUMNS = `id, project_id, title, status, intent_json, authorization_json,
  next_heartbeat_at, last_heartbeat_at, created_at, updated_at`;
const UPDATE_COLUMNS = [
  "project_id", "title", "status", "intent_json", "authorization_json",
  "next_heartbeat_at", "last_heartbeat_at"
] as const;

export function createPiDelegation(db: RunnerDatabase, input: PiDelegationInput): PiDelegation {
  const record = normalizeDelegationCreate(input);
  db.sqlite.run(`insert into ${TABLE} (${COLUMNS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    record.id, record.project_id, record.title, record.status, record.intent_json,
    record.authorization_json, record.next_heartbeat_at, record.last_heartbeat_at,
    record.created_at, record.updated_at
  ]);
  return mustGetPiDelegation(db, record.id);
}

export function getPiDelegation(db: RunnerDatabase, id: string): PiDelegation | null {
  return getByID(db, TABLE, COLUMNS, id, mapDelegation);
}

export function listPiDelegations(db: RunnerDatabase, filter: PiDelegationFilter = {}): PiDelegation[] {
  return listRows(db, TABLE, COLUMNS, mapDelegation, buildFilter([
    ["project_id=?", filter.projectId],
    ["status=?", filter.status]
  ], "created_at desc, id asc"));
}

export function updatePiDelegation(db: RunnerDatabase, id: string, input: PiDelegationInput): PiDelegation {
  updateByID<PiDelegation>(db, TABLE, UPDATE_COLUMNS, id, normalizeDelegationPatch(input));
  return mustGetPiDelegation(db, id);
}

function normalizeDelegationCreate(input: PiDelegationInput): PiDelegation {
  const timestamp = now();
  return {
    id: cleanString(input.id) || crypto.randomUUID(),
    project_id: requiredString(input.project_id, "project_id"),
    title: cleanString(input.title),
    status: cleanString(input.status) || "active",
    intent_json: jsonText(input.intent_json, "{}"),
    authorization_json: jsonText(input.authorization_json, "{}"),
    next_heartbeat_at: cleanString(input.next_heartbeat_at),
    last_heartbeat_at: cleanString(input.last_heartbeat_at),
    created_at: timestamp,
    updated_at: timestamp
  };
}

function normalizeDelegationPatch(input: PiDelegationInput): PiDelegationInput {
  return {
    ...input,
    authorization_json: input.authorization_json === undefined ? undefined : jsonText(input.authorization_json, "{}"),
    intent_json: input.intent_json === undefined ? undefined : jsonText(input.intent_json, "{}")
  };
}

function mustGetPiDelegation(db: RunnerDatabase, id: string): PiDelegation {
  const delegation = getPiDelegation(db, id);
  if (!delegation) throw new Error("PI delegation missing after write");
  return delegation;
}

function mapDelegation(row: Record<string, unknown>): PiDelegation {
  return {
    id: requiredString(row.id, "pi_delegations.id"),
    project_id: optionalString(row.project_id),
    title: optionalString(row.title),
    status: requiredString(row.status, "pi_delegations.status"),
    intent_json: optionalString(row.intent_json) || "{}",
    authorization_json: optionalString(row.authorization_json) || "{}",
    next_heartbeat_at: optionalString(row.next_heartbeat_at),
    last_heartbeat_at: optionalString(row.last_heartbeat_at),
    created_at: requiredString(row.created_at, "created_at"),
    updated_at: requiredString(row.updated_at, "updated_at")
  };
}
