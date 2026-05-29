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

export type PiAction = {
  id: string; project_id: string; issue_id: number; conversation_id: string; action_type: string;
  status: string; risk_level: string; requires_confirmation: number; payload_json: string;
  result_json: string; rationale: string; created_at: string; updated_at: string;
};

export type PiActionInput = PatchInput<PiAction>;
export type PiActionFilter = { conversationId?: string; issueId?: number; projectId?: string; status?: string };

const TABLE = "pi_actions";
const COLUMNS = `id, project_id, issue_id, conversation_id, action_type, status,
  risk_level, requires_confirmation, payload_json, result_json, rationale, created_at, updated_at`;
const UPDATE_COLUMNS = [
  "project_id", "issue_id", "conversation_id", "action_type", "status", "risk_level",
  "requires_confirmation", "payload_json", "result_json", "rationale"
] as const;

export function createPiAction(db: RunnerDatabase, input: PiActionInput): PiAction {
  const record = normalizeCreate(input);
  requireCreateFields(record, ["id", "action_type", "status"]);
  const timestamp = now();
  db.sqlite.run(`insert into ${TABLE} (${COLUMNS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [record.id, record.project_id, record.issue_id, record.conversation_id, record.action_type,
      record.status, record.risk_level, record.requires_confirmation, record.payload_json,
      record.result_json, record.rationale, timestamp, timestamp]);
  return mustGetPiAction(db, record.id);
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

function mustGetPiAction(db: RunnerDatabase, id: string): PiAction {
  const record = getPiAction(db, id);
  if (!record) throw new Error("PI action missing after write");
  return record;
}

function normalizeCreate(input: PiActionInput): PiAction {
  return {
    id: cleanString(input.id), project_id: cleanString(input.project_id),
    issue_id: integerInput(input.issue_id), conversation_id: cleanString(input.conversation_id),
    action_type: cleanString(input.action_type), status: cleanString(input.status),
    risk_level: cleanString(input.risk_level) || "low",
    requires_confirmation: integerInput(input.requires_confirmation),
    payload_json: jsonText(input.payload_json, "{}"), result_json: jsonText(input.result_json, "{}"),
    rationale: cleanString(input.rationale), created_at: "", updated_at: ""
  };
}

function normalizePatch(input: PiActionInput): PiActionInput {
  return {
    ...input,
    payload_json: input.payload_json === undefined ? undefined : jsonText(input.payload_json, "{}"),
    result_json: input.result_json === undefined ? undefined : jsonText(input.result_json, "{}")
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
    rationale: optionalString(row.rationale),
    created_at: requiredString(row.created_at, "pi_actions.created_at"),
    updated_at: requiredString(row.updated_at, "pi_actions.updated_at")
  };
}
