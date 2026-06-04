import type { RunnerDatabase } from "../../database.ts";
import {
  buildFilter,
  cleanString,
  getByID,
  integerValue,
  jsonText,
  listRows,
  now,
  optionalString,
  requiredString,
  type PatchInput
} from "./common.ts";

export type PiReportRecord = {
  id: number; project_id: string; type: string; status: string; source: string;
  since_at: string; until_at: string; delegation_id: string; heartbeat_id: string;
  issue_ids_json: string; summary_json: string; body_json: string;
  generated_at: string; created_at: string; updated_at: string;
};
export type PiReportInput = PatchInput<PiReportRecord>;
export type PiReportFilter = {
  delegationId?: string; heartbeatId?: string; projectId?: string; source?: string; status?: string; type?: string;
};

const TABLE = "pi_reports";
const COLUMNS = `id, project_id, type, status, source, since_at, until_at,
  delegation_id, heartbeat_id, issue_ids_json, summary_json, body_json,
  generated_at, created_at, updated_at`;

export function createPiReportRecord(db: RunnerDatabase, input: PiReportInput): PiReportRecord {
  const record = normalizeCreate(input);
  const timestamp = now();
  db.sqlite.run(`insert into ${TABLE} (${insertColumns()}) values (${placeholders(14)})`, [
    record.project_id, record.type, record.status, record.source, record.since_at,
    record.until_at, record.delegation_id, record.heartbeat_id, record.issue_ids_json,
    record.summary_json, record.body_json, record.generated_at, timestamp, timestamp
  ]);
  return mustGetPiReportRecord(db, lastInsertID(db));
}

export function getPiReportRecord(db: RunnerDatabase, id: number): PiReportRecord | null {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return getByID(db, TABLE, COLUMNS, String(id), mapReport, "id");
}

export function listPiReportRecords(db: RunnerDatabase, filter: PiReportFilter = {}): PiReportRecord[] {
  return listRows(db, TABLE, COLUMNS, mapReport, buildFilter([
    ["project_id=?", filter.projectId],
    ["delegation_id=?", filter.delegationId],
    ["heartbeat_id=?", filter.heartbeatId],
    ["status=?", filter.status],
    ["source=?", filter.source],
    ["type=?", filter.type]
  ], "generated_at desc, id desc"));
}

function normalizeCreate(input: PiReportInput): PiReportRecord {
  const timestamp = now();
  return {
    id: 0,
    project_id: cleanString(input.project_id),
    type: cleanString(input.type) || "manual",
    status: cleanString(input.status) || "generated",
    source: cleanString(input.source) || "manual",
    since_at: cleanString(input.since_at),
    until_at: cleanString(input.until_at),
    delegation_id: cleanString(input.delegation_id),
    heartbeat_id: cleanString(input.heartbeat_id),
    issue_ids_json: jsonText(input.issue_ids_json, "[]"),
    summary_json: jsonText(input.summary_json, "{}"),
    body_json: jsonText(input.body_json, "{}"),
    generated_at: cleanString(input.generated_at) || timestamp,
    created_at: "",
    updated_at: ""
  };
}

function mapReport(row: Record<string, unknown>): PiReportRecord {
  return {
    id: integerValue(row.id, "pi_reports.id"),
    project_id: optionalString(row.project_id),
    type: requiredString(row.type, "pi_reports.type"),
    status: optionalString(row.status) || "generated",
    source: optionalString(row.source) || "manual",
    since_at: optionalString(row.since_at),
    until_at: optionalString(row.until_at),
    delegation_id: optionalString(row.delegation_id),
    heartbeat_id: optionalString(row.heartbeat_id),
    issue_ids_json: optionalString(row.issue_ids_json) || "[]",
    summary_json: optionalString(row.summary_json) || "{}",
    body_json: optionalString(row.body_json) || "{}",
    generated_at: requiredString(row.generated_at, "pi_reports.generated_at"),
    created_at: requiredString(row.created_at, "pi_reports.created_at"),
    updated_at: requiredString(row.updated_at, "pi_reports.updated_at")
  };
}

function mustGetPiReportRecord(db: RunnerDatabase, id: number): PiReportRecord {
  const record = getPiReportRecord(db, id);
  if (!record) throw new Error("PI report missing after write");
  return record;
}

function lastInsertID(db: RunnerDatabase): number {
  return db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0;
}

function insertColumns(): string {
  return `project_id, type, status, source, since_at, until_at, delegation_id,
    heartbeat_id, issue_ids_json, summary_json, body_json, generated_at, created_at, updated_at`;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
