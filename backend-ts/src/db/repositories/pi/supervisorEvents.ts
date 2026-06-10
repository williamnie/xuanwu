import type { RunnerDatabase } from "../../database.ts";
import {
  buildFilter,
  cleanString,
  integerInput,
  integerValue,
  listRows,
  now,
  optionalString,
  requiredString,
  requireCreateFields,
  type PatchInput
} from "./common.ts";
import { redactAuditJsonText } from "./auditRedaction.ts";

export type IssueSupervisorEvent = {
  action_id: string; action_type: string; confidence: string; created_at: string;
  decision: string; diagnosis_code: string; event_type: string; id: number; issue_id: number;
  payload_json: string; project_id: string; provider: string; provider_error_category: string;
  provider_session_id: string; provider_turn_id: string; retry_after_at: string; run_id: string;
};
export type IssueSupervisorEventInput = PatchInput<IssueSupervisorEvent>;
export type IssueSupervisorEventFilter = {
  actionId?: string;
  eventType?: string;
  issueId?: number;
  projectId?: string;
};

const TABLE = "issue_supervisor_events";
const COLUMNS = `id, issue_id, project_id, run_id, provider, provider_session_id,
  provider_turn_id, event_type, diagnosis_code, provider_error_category,
  retry_after_at, decision, confidence, action_id, action_type, payload_json, created_at`;

export function createIssueSupervisorEvent(
  db: RunnerDatabase,
  input: IssueSupervisorEventInput
): IssueSupervisorEvent {
  const record = normalizeCreate(input);
  requireCreateFields(record, ["event_type"]);
  db.sqlite.run(`insert into ${TABLE} (${insertColumns()}) values (${placeholders(16)})`, [
    record.issue_id, record.project_id, record.run_id, record.provider,
    record.provider_session_id, record.provider_turn_id, record.event_type,
    record.diagnosis_code, record.provider_error_category, record.retry_after_at,
    record.decision, record.confidence, record.action_id, record.action_type,
    record.payload_json, now()
  ]);
  return mustGetIssueSupervisorEvent(db, lastInsertID(db));
}

export function listIssueSupervisorEvents(
  db: RunnerDatabase,
  filter: IssueSupervisorEventFilter = {}
): IssueSupervisorEvent[] {
  return listRows(db, TABLE, COLUMNS, mapIssueSupervisorEvent, buildFilter([
    ["project_id=?", filter.projectId],
    ["issue_id=?", filter.issueId],
    ["event_type=?", filter.eventType],
    ["action_id=?", filter.actionId]
  ], "created_at asc, id asc"));
}

function mustGetIssueSupervisorEvent(db: RunnerDatabase, id: number): IssueSupervisorEvent {
  const row = db.sqlite.query<Record<string, unknown>, [number]>(
    `select ${COLUMNS} from ${TABLE} where id=?`
  ).get(id);
  if (!row) throw new Error("issue supervisor event missing after write");
  return mapIssueSupervisorEvent(row);
}

function normalizeCreate(input: IssueSupervisorEventInput): IssueSupervisorEvent {
  return {
    action_id: cleanString(input.action_id),
    action_type: cleanString(input.action_type),
    confidence: cleanString(input.confidence),
    created_at: "",
    decision: cleanString(input.decision),
    diagnosis_code: cleanString(input.diagnosis_code),
    event_type: cleanString(input.event_type),
    id: 0,
    issue_id: integerInput(input.issue_id),
    payload_json: payloadText(input.payload_json),
    project_id: cleanString(input.project_id),
    provider: cleanString(input.provider),
    provider_error_category: cleanString(input.provider_error_category),
    provider_session_id: cleanString(input.provider_session_id),
    provider_turn_id: cleanString(input.provider_turn_id),
    retry_after_at: cleanString(input.retry_after_at),
    run_id: cleanString(input.run_id)
  };
}

function mapIssueSupervisorEvent(row: Record<string, unknown>): IssueSupervisorEvent {
  return {
    action_id: optionalString(row.action_id),
    action_type: optionalString(row.action_type),
    confidence: optionalString(row.confidence),
    created_at: requiredString(row.created_at, "issue_supervisor_events.created_at"),
    decision: optionalString(row.decision),
    diagnosis_code: optionalString(row.diagnosis_code),
    event_type: requiredString(row.event_type, "issue_supervisor_events.event_type"),
    id: integerValue(row.id, "issue_supervisor_events.id"),
    issue_id: integerValue(row.issue_id, "issue_supervisor_events.issue_id"),
    payload_json: redactAuditJsonText(optionalString(row.payload_json) || "{}"),
    project_id: optionalString(row.project_id),
    provider: optionalString(row.provider),
    provider_error_category: optionalString(row.provider_error_category),
    provider_session_id: optionalString(row.provider_session_id),
    provider_turn_id: optionalString(row.provider_turn_id),
    retry_after_at: optionalString(row.retry_after_at),
    run_id: optionalString(row.run_id)
  };
}

function payloadText(value: unknown): string {
  if (typeof value === "string") return redactAuditJsonText(value || "{}");
  return redactAuditJsonText(JSON.stringify(value ?? {}));
}

function lastInsertID(db: RunnerDatabase): number {
  return db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0;
}

function insertColumns(): string {
  return `issue_id, project_id, run_id, provider, provider_session_id, provider_turn_id,
    event_type, diagnosis_code, provider_error_category, retry_after_at, decision,
    confidence, action_id, action_type, payload_json, created_at`;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
