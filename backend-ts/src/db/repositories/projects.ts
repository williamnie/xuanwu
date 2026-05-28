import type { RunnerDatabase } from "../database.ts";

type ProjectRow = {
  approval_policy: unknown;
  auto_run: unknown;
  created_at: unknown;
  cwd: unknown;
  default_agent_profile_id: unknown;
  id: unknown;
  model: unknown;
  name: unknown;
  provider: unknown;
  provider_config_json: unknown;
  sandbox: unknown;
  sort_order: unknown;
  updated_at: unknown;
};

export type Project = {
  approval_policy: string;
  auto_run: number;
  created_at: string;
  cwd: string;
  default_agent_profile_id: string;
  id: string;
  model: string;
  name: string;
  provider: string;
  provider_config_json: string;
  sandbox: string;
  sort_order: number;
  updated_at: string;
};

const PROJECT_COLUMNS = `id, name, cwd, provider, provider_config_json, auto_run,
  model, approval_policy, sandbox, default_agent_profile_id, sort_order,
  created_at, updated_at`;

export function listProjects(db: RunnerDatabase): Project[] {
  return db.sqlite.query<ProjectRow, []>(`
    select ${PROJECT_COLUMNS} from projects
    order by sort_order asc, created_at asc, id asc
  `).all().map(mapProjectRow);
}

export function getProject(db: RunnerDatabase, id: string): Project | null {
  const projectID = cleanRequiredString(id, "project id");
  const row = db.sqlite.query<ProjectRow, [string]>(`
    select ${PROJECT_COLUMNS} from projects where id = ?
  `).get(projectID);
  return row ? mapProjectRow(row) : null;
}

function mapProjectRow(row: ProjectRow): Project {
  return {
    id: requiredString(row.id, "projects.id"),
    name: requiredString(row.name, "projects.name"),
    cwd: requiredString(row.cwd, "projects.cwd"),
    provider: normalizedProvider(row.provider),
    provider_config_json: optionalString(row.provider_config_json, "{}"),
    auto_run: integerValue(row.auto_run, "projects.auto_run"),
    model: normalizedModel(row.model),
    approval_policy: optionalString(row.approval_policy, "never"),
    sandbox: optionalString(row.sandbox, "workspace-write"),
    default_agent_profile_id: optionalString(row.default_agent_profile_id),
    sort_order: integerValue(row.sort_order, "projects.sort_order"),
    created_at: requiredString(row.created_at, "projects.created_at"),
    updated_at: requiredString(row.updated_at, "projects.updated_at")
  };
}

function cleanRequiredString(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new Error(`${label} is required`);
  return trimmed;
}

function requiredString(value: unknown, label: string): string {
  const text = optionalString(value);
  if (text === "") throw new Error(`${label} is required`);
  return text;
}

function optionalString(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") throw new Error(`expected string row value`);
  const trimmed = value.trim();
  return trimmed === "" ? fallback : trimmed;
}

function integerValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return value;
}

function normalizedProvider(value: unknown): string {
  return optionalString(value, "codex").toLowerCase();
}

function normalizedModel(value: unknown): string {
  const model = optionalString(value);
  if (model === "" || model.toLowerCase().startsWith("gemini-")) return "codex-default";
  return model;
}
