import type { RunnerDatabase } from "../../database.ts";
import {
  cleanString,
  deleteByID,
  getByID,
  integerInput,
  integerValue,
  listRows,
  now,
  requiredString,
  requireCreateFields,
  updateByID,
  type PatchInput
} from "./common.ts";

export type ProjectPiSettings = {
  project_id: string; pi_agent_id: string; auto_manage: number; auto_triage: number;
  auto_enqueue: number; notify_on_needs_user: number; max_actions_per_cycle: number;
  created_at: string; updated_at: string;
};

export type ProjectPiSettingsInput = PatchInput<ProjectPiSettings>;

const TABLE = "project_pi_settings";
const COLUMNS = `project_id, pi_agent_id, auto_manage, auto_triage, auto_enqueue,
  notify_on_needs_user, max_actions_per_cycle, created_at, updated_at`;
const UPDATE_COLUMNS = [
  "pi_agent_id", "auto_manage", "auto_triage", "auto_enqueue",
  "notify_on_needs_user", "max_actions_per_cycle"
] as const;

export function createProjectPiSettings(db: RunnerDatabase, input: ProjectPiSettingsInput): ProjectPiSettings {
  const record = normalizeCreate(input);
  requireCreateFields(record, ["project_id", "pi_agent_id"]);
  const timestamp = now();
  db.sqlite.run(`insert into ${TABLE} (${COLUMNS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [record.project_id, record.pi_agent_id, record.auto_manage, record.auto_triage,
      record.auto_enqueue, record.notify_on_needs_user, record.max_actions_per_cycle,
      timestamp, timestamp]);
  return mustGetProjectPiSettings(db, record.project_id);
}

export function updateProjectPiSettings(
  db: RunnerDatabase,
  projectID: string,
  input: ProjectPiSettingsInput
): ProjectPiSettings {
  updateByID<ProjectPiSettings>(db, TABLE, UPDATE_COLUMNS, projectID, input, "project_id");
  return mustGetProjectPiSettings(db, projectID);
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
    project_id: cleanString(input.project_id), pi_agent_id: cleanString(input.pi_agent_id),
    auto_manage: integerInput(input.auto_manage), auto_triage: integerInput(input.auto_triage),
    auto_enqueue: integerInput(input.auto_enqueue),
    notify_on_needs_user: integerInput(input.notify_on_needs_user, 1),
    max_actions_per_cycle: integerInput(input.max_actions_per_cycle, 5),
    created_at: "", updated_at: ""
  };
}

function mapProjectPiSettings(row: Record<string, unknown>): ProjectPiSettings {
  return {
    project_id: requiredString(row.project_id, "project_pi_settings.project_id"),
    pi_agent_id: requiredString(row.pi_agent_id, "project_pi_settings.pi_agent_id"),
    auto_manage: integerValue(row.auto_manage, "project_pi_settings.auto_manage"),
    auto_triage: integerValue(row.auto_triage, "project_pi_settings.auto_triage"),
    auto_enqueue: integerValue(row.auto_enqueue, "project_pi_settings.auto_enqueue"),
    notify_on_needs_user: integerValue(row.notify_on_needs_user, "project_pi_settings.notify_on_needs_user"),
    max_actions_per_cycle: integerValue(row.max_actions_per_cycle, "project_pi_settings.max_actions_per_cycle"),
    created_at: requiredString(row.created_at, "project_pi_settings.created_at"),
    updated_at: requiredString(row.updated_at, "project_pi_settings.updated_at")
  };
}
