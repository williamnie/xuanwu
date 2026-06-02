import type { RunnerDatabase } from "../../database.ts";
import {
  cleanString,
  jsonText,
  now,
  optionalString,
  requiredString,
  type PatchInput
} from "./common.ts";
import type { PiDelegation } from "./heartbeats.ts";

export type PiDelegationInput = PatchInput<PiDelegation>;

const TABLE = "pi_delegations";
const COLUMNS = `id, project_id, title, status, intent_json, authorization_json,
  next_heartbeat_at, last_heartbeat_at, created_at, updated_at`;

export function createPiDelegation(db: RunnerDatabase, input: PiDelegationInput): PiDelegation {
  const record = normalizeDelegationCreate(input);
  db.sqlite.run(`insert into ${TABLE} (${COLUMNS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    record.id, record.project_id, record.title, record.status, record.intent_json,
    record.authorization_json, record.next_heartbeat_at, record.last_heartbeat_at,
    record.created_at, record.updated_at
  ]);
  return mustGetPiDelegation(db, record.id);
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

function mustGetPiDelegation(db: RunnerDatabase, id: string): PiDelegation {
  const row = db.sqlite.query<Record<string, unknown>, [string]>(
    `select ${COLUMNS} from ${TABLE} where id=?`
  ).get(id);
  if (!row) throw new Error("PI delegation missing after write");
  return mapDelegation(row);
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
