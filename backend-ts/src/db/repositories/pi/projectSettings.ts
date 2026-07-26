import type { RunnerDatabase } from "../../database.ts";
import {
  cleanString,
  deleteByID,
  getByID,
  listRows,
  now,
  requiredString,
  requireCreateFields,
  type PatchInput
} from "./common.ts";

export type ProjectPiSettings = {
  project_id: string;
  created_at: string; updated_at: string;
};

export type ProjectPiSettingsInput = PatchInput<ProjectPiSettings>;

const TABLE = "project_pi_settings";
const COLUMNS = "project_id, created_at, updated_at";

export function createProjectPiSettings(db: RunnerDatabase, input: ProjectPiSettingsInput): ProjectPiSettings {
  const record = normalizeCreate(input);
  requireCreateFields(record, ["project_id"]);
  const timestamp = now();
  db.sqlite.run(`insert into ${TABLE} (${COLUMNS}) values (?, ?, ?)`,
    [record.project_id, timestamp, timestamp]);
  return mustGetProjectPiSettings(db, record.project_id);
}

export function listProjectPiSettings(db: RunnerDatabase): ProjectPiSettings[] {
  return listRows(db, TABLE, COLUMNS, mapProjectPiSettings, { args: [], sql: " order by project_id asc" });
}

export function getProjectPiSettings(db: RunnerDatabase, projectID: string): ProjectPiSettings | null {
  return getByID(db, TABLE, COLUMNS, projectID, mapProjectPiSettings, "project_id");
}

export function deleteProjectPiSettings(db: RunnerDatabase, projectID: string): boolean {
  return deleteByID(db, TABLE, projectID, "project_id");
}

function mustGetProjectPiSettings(db: RunnerDatabase, id: string): ProjectPiSettings {
  const record = getProjectPiSettings(db, id);
  if (!record) throw new Error("project PI settings missing after write");
  return record;
}

function normalizeCreate(input: ProjectPiSettingsInput): ProjectPiSettings {
  return {
    project_id: cleanString(input.project_id),
    created_at: "", updated_at: ""
  };
}

function mapProjectPiSettings(row: Record<string, unknown>): ProjectPiSettings {
  return {
    project_id: requiredString(row.project_id, "project_pi_settings.project_id"),
    created_at: requiredString(row.created_at, "project_pi_settings.created_at"),
    updated_at: requiredString(row.updated_at, "project_pi_settings.updated_at")
  };
}
