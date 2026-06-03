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
  id: number; project_id: string; type: string; summary_json: string;
  body_json: string; generated_at: string; created_at: string; updated_at: string;
};
export type PiReportInput = PatchInput<PiReportRecord>;
export type PiReportFilter = { projectId?: string; type?: string };

const TABLE = "pi_reports";
const COLUMNS = `id, project_id, type, summary_json, body_json, generated_at, created_at, updated_at`;

export function createPiReportRecord(db: RunnerDatabase, input: PiReportInput): PiReportRecord {
  const record = normalizeCreate(input);
  const timestamp = now();
  db.sqlite.run(`insert into ${TABLE} (project_id, type, summary_json, body_json, generated_at, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?)`, [
    record.project_id, record.type, record.summary_json, record.body_json,
    record.generated_at, timestamp, timestamp
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
    ["type=?", filter.type]
  ], "generated_at desc, id desc"));
}

function normalizeCreate(input: PiReportInput): PiReportRecord {
  const timestamp = now();
  return {
    id: 0,
    project_id: cleanString(input.project_id),
    type: cleanString(input.type) || "manual",
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
