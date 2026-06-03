import type { RunnerDatabase } from "../../database.ts";
import { normalizeSkillIntentList } from "../../../skills/intents.ts";
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
export type PiDelegationStatus = "active" | "paused" | "expired";

const TABLE = "pi_delegations";
const COLUMNS = `id, project_id, title, status, intent_json, authorization_json,
  scope_json, starts_at, expires_at, allowed_actions_json, forbidden_actions_json,
  allowed_skill_intents_json, audit_source, next_heartbeat_at, last_heartbeat_at,
  created_at, updated_at`;
const UPDATE_COLUMNS = [
  "project_id", "title", "status", "intent_json", "authorization_json",
  "scope_json", "starts_at", "expires_at", "allowed_actions_json",
  "forbidden_actions_json", "allowed_skill_intents_json", "audit_source",
  "next_heartbeat_at", "last_heartbeat_at"
] as const;

export function createPiDelegation(db: RunnerDatabase, input: PiDelegationInput): PiDelegation {
  const record = normalizeDelegationCreate(input);
  db.sqlite.run(`insert into ${TABLE} (${COLUMNS}) values (${placeholders(17)})`, [
    record.id, record.project_id, record.title, record.status, record.intent_json,
    record.authorization_json, record.scope_json, record.starts_at, record.expires_at,
    record.allowed_actions_json, record.forbidden_actions_json, record.allowed_skill_intents_json,
    record.audit_source, record.next_heartbeat_at, record.last_heartbeat_at,
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
  const patch = normalizeDelegationPatch(input);
  const current = patch.status === undefined ? null : requirePiDelegation(db, id);
  if (current && patch.status) assertTransition(current, patch.status);
  updateByID<PiDelegation>(db, TABLE, UPDATE_COLUMNS, id, patch);
  return mustGetPiDelegation(db, id);
}

export function pausePiDelegation(db: RunnerDatabase, id: string): PiDelegation {
  return updatePiDelegation(db, id, { status: "paused" });
}

export function resumePiDelegation(db: RunnerDatabase, id: string): PiDelegation {
  return updatePiDelegation(db, id, { status: "active" });
}

export function expirePiDelegation(db: RunnerDatabase, id: string): PiDelegation {
  return updatePiDelegation(db, id, { status: "expired" });
}

function normalizeDelegationCreate(input: PiDelegationInput): PiDelegation {
  const timestamp = now();
  const authorization = jsonText(input.authorization_json, "{}");
  const auth = objectValue(authorization);
  return {
    id: cleanString(input.id) || crypto.randomUUID(),
    project_id: requiredString(input.project_id, "project_id"),
    title: cleanString(input.title),
    status: delegationStatus(input.status, "active"),
    intent_json: jsonText(input.intent_json, "{}"),
    authorization_json: authorization,
    scope_json: jsonField(input.scope_json, jsonObjectField(auth.scope ?? auth.scopes, "{}")),
    starts_at: cleanString(input.starts_at) || cleanString(auth.starts_at ?? auth.startsAt),
    expires_at: cleanString(input.expires_at) || cleanString(auth.expires_at ?? auth.expiresAt),
    allowed_actions_json: jsonField(input.allowed_actions_json, jsonObjectField(auth.allowed_actions ?? auth.allowedActions, "[]")),
    forbidden_actions_json: jsonField(input.forbidden_actions_json, jsonObjectField(auth.forbidden_actions ?? auth.forbiddenActions, "[]")),
    allowed_skill_intents_json: normalizeSkillIntentList(input.allowed_skill_intents_json ?? auth.allowed_skill_intents ?? auth.allowedSkillIntents),
    audit_source: cleanString(input.audit_source) || cleanString(auth.audit_source ?? auth.source ?? auth.authorized_by),
    next_heartbeat_at: cleanString(input.next_heartbeat_at),
    last_heartbeat_at: cleanString(input.last_heartbeat_at),
    created_at: timestamp,
    updated_at: timestamp
  };
}

function normalizeDelegationPatch(input: PiDelegationInput): PiDelegationInput {
  return {
    ...input,
    allowed_actions_json: input.allowed_actions_json === undefined ? undefined : jsonField(input.allowed_actions_json, "[]"),
    allowed_skill_intents_json: input.allowed_skill_intents_json === undefined ? undefined : normalizeSkillIntentList(input.allowed_skill_intents_json),
    authorization_json: input.authorization_json === undefined ? undefined : jsonText(input.authorization_json, "{}"),
    forbidden_actions_json: input.forbidden_actions_json === undefined ? undefined : jsonField(input.forbidden_actions_json, "[]"),
    intent_json: input.intent_json === undefined ? undefined : jsonText(input.intent_json, "{}"),
    scope_json: input.scope_json === undefined ? undefined : jsonField(input.scope_json, "{}"),
    status: patchStatus(input)
  };
}

function mustGetPiDelegation(db: RunnerDatabase, id: string): PiDelegation {
  const delegation = getPiDelegation(db, id);
  if (!delegation) throw new Error("PI delegation missing after write");
  return delegation;
}

function requirePiDelegation(db: RunnerDatabase, id: string): PiDelegation {
  const delegation = getPiDelegation(db, id);
  if (!delegation) throw new Error(`PI delegation ${cleanString(id)} not found`);
  return delegation;
}

function assertTransition(current: PiDelegation, next: PiDelegationStatus): void {
  const allowed = current.status === "expired" ? ["expired"] : ["active", "paused", "expired"];
  if (allowed.includes(next)) return;
  throw new Error(`cannot transition PI delegation ${current.id} from ${current.status} to ${next}`);
}

function mapDelegation(row: Record<string, unknown>): PiDelegation {
  return {
    id: requiredString(row.id, "pi_delegations.id"),
    project_id: optionalString(row.project_id),
    title: optionalString(row.title),
    status: requiredString(row.status, "pi_delegations.status"),
    intent_json: optionalString(row.intent_json) || "{}",
    authorization_json: optionalString(row.authorization_json) || "{}",
    scope_json: optionalString(row.scope_json) || "{}",
    starts_at: optionalString(row.starts_at),
    expires_at: optionalString(row.expires_at),
    allowed_actions_json: optionalString(row.allowed_actions_json) || "[]",
    forbidden_actions_json: optionalString(row.forbidden_actions_json) || "[]",
    allowed_skill_intents_json: optionalString(row.allowed_skill_intents_json) || "[]",
    audit_source: optionalString(row.audit_source),
    next_heartbeat_at: optionalString(row.next_heartbeat_at),
    last_heartbeat_at: optionalString(row.last_heartbeat_at),
    created_at: requiredString(row.created_at, "created_at"),
    updated_at: requiredString(row.updated_at, "updated_at")
  };
}

function jsonField(value: unknown, fallback: string): string {
  const text = cleanString(value);
  if (text !== "") return text;
  return jsonObjectField(value, fallback);
}

function jsonObjectField(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") return cleanString(value) || fallback;
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function objectValue(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function patchStatus(input: PiDelegationInput): PiDelegationStatus | undefined {
  if (!Object.hasOwn(input, "status") || input.status === undefined || input.status === null) return undefined;
  return delegationStatus(input.status);
}

function delegationStatus(value: unknown, fallback?: PiDelegationStatus): PiDelegationStatus {
  const status = cleanString(value) || fallback || "";
  if (status === "active" || status === "paused" || status === "expired") return status;
  throw new Error(`unsupported PI delegation status: ${status || "<empty>"}`);
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
