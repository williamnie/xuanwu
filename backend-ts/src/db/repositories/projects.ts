import { statSync } from "node:fs";
import type { RunnerDatabase } from "../database.ts";
import { getAgentProfile, type AgentProfile } from "./agentProfiles.ts";
import { normalizeProjectForWrite, normalizeProjectModel, normalizeProjectPatch, normalizeProjectProvider, normalizeProjectProviderConfig, type NormalizedProjectWrite, type ProjectPatchInput, type ProjectWriteInput } from "./projectUtils.ts";
import type { ExecutionPolicyRequest } from "../../providers/core/policyContracts.ts";
import { readStoredExecutionPolicy } from "../../providers/core/policyPersistence.ts";

type ProjectRow = {
  hold_since: unknown;
  last_check_at: unknown;
  last_check_error: unknown;
  message: unknown;
  next_check_at: unknown;
  reason: unknown;
  approval_policy: unknown;
  auto_run: unknown;
  created_at: unknown;
  cwd: unknown;
  default_agent_profile_id: unknown;
  default_mcp_policy_json: unknown;
  default_service_tier: unknown;
  default_skill_policy_json: unknown;
  execution_policy_json: unknown;
  id: unknown;
  model: unknown;
  name: unknown;
  pi_managed: unknown;
  provider: unknown;
  provider_config_json: unknown;
  sandbox: unknown;
  sort_order: unknown;
  updated_at: unknown;
};

export type CreateProjectInput = ProjectWriteInput;

export type UpdateProjectInput = ProjectPatchInput;

export type ProjectHold = { reason: string; message: string; hold_since: string; next_check_at: string; last_check_at: string; last_check_error: string };

export type Project = {
  approval_policy: string;
  auto_run: number;
  created_at: string;
  cwd: string;
  default_agent_profile?: AgentProfile;
  default_agent_profile_id: string;
  default_mcp_policy: string;
  default_service_tier: string;
  default_skill_policy: string;
  execution_policy: ExecutionPolicyRequest;
  execution_policy_json: string;
  execution_policy_source: string;
  execution_policy_warnings: string[];
  hold?: ProjectHold;
  id: string;
  loop_status: string;
  model: string;
  name: string;
  pi_managed: number;
  provider: string;
  provider_capabilities: string[];
  provider_config_json: string;
  sandbox: string;
  sort_order: number;
  updated_at: string;
};

const PROJECT_COLUMNS = `p.id, p.name, p.cwd, p.provider, p.provider_config_json, p.auto_run,
  p.model, p.approval_policy, p.sandbox, p.execution_policy_json, p.default_agent_profile_id, p.default_skill_policy_json,
  p.default_mcp_policy_json, p.default_service_tier, p.sort_order,
  p.created_at, p.updated_at, h.reason, h.message, h.hold_since, h.next_check_at,
  h.last_check_at, h.last_check_error,
  case when exists(select 1 from project_pi_settings s where s.project_id=p.id) then 1 else 0 end as pi_managed`;


export function createProject(db: RunnerDatabase, input: CreateProjectInput): Project {
  const project = normalizeProjectForWrite(input);
  validateProjectForWrite(project.id, project.cwd);
  const existing = getProjectByCWD(db, project.cwd);
  if (existing) return updateProject(db, existing.id, project);
  const timestamp = now();
  const sortOrder = nextProjectSortOrder(db);
  db.sqlite.run(`insert into projects
    (id, name, cwd, provider, provider_config_json, auto_run, model,
     approval_policy, sandbox, execution_policy_json, default_agent_profile_id, default_skill_policy_json, default_mcp_policy_json,
     default_service_tier, sort_order, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [project.id, project.name, project.cwd, project.provider, project.provider_config_json,
      project.auto_run, project.model, project.approval_policy, project.sandbox, project.execution_policy_json,
      project.default_agent_profile_id, project.default_skill_policy, project.default_mcp_policy,
      project.default_service_tier, sortOrder, timestamp, timestamp]);
  return mustGetProject(db, project.id);
}

export function updateProject(db: RunnerDatabase, id: string, input: UpdateProjectInput): Project {
  const projectID = cleanRequiredString(id, "project id");
  const current = getProject(db, projectID);
  if (!current) throw new ProjectNotFoundError();
  const patch = normalizeProjectPatch(projectToWriteShape(current), input);
  const next = { ...projectToWriteShape(current), ...patch };
  validateProjectForWrite(projectID, next.cwd);
  db.sqlite.run(`update projects set name=?, cwd=?, provider=?, provider_config_json=?,
    auto_run=?, model=?, approval_policy=?, sandbox=?, execution_policy_json=?, default_agent_profile_id=?,
    default_skill_policy_json=?, default_mcp_policy_json=?, default_service_tier=?, updated_at=? where id=?`,
    [next.name, next.cwd, next.provider, next.provider_config_json, next.auto_run,
      next.model, next.approval_policy, next.sandbox, next.execution_policy_json, next.default_agent_profile_id,
      next.default_skill_policy, next.default_mcp_policy, next.default_service_tier, now(), projectID]);
  return mustGetProject(db, projectID);
}

export function listProjects(db: RunnerDatabase): Project[] {
  const projects = db.sqlite.query<ProjectRow, []>(`
    select ${PROJECT_COLUMNS} from projects p left join project_holds h on h.project_id=p.id
    order by p.sort_order asc, p.created_at asc, p.id asc
  `).all().map(mapProjectRow);
  return attachAgentProfiles(db, projects);
}

export function getProject(db: RunnerDatabase, id: string): Project | null {
  const projectID = cleanRequiredString(id, "project id");
  const row = db.sqlite.query<ProjectRow, [string]>(`
    select ${PROJECT_COLUMNS} from projects p left join project_holds h on h.project_id=p.id where p.id = ?
  `).get(projectID);
  if (!row) return null;
  return attachAgentProfiles(db, [mapProjectRow(row)])[0] ?? null;
}

function getProjectByCWD(db: RunnerDatabase, cwd: string): Project | null {
  const row = db.sqlite.query<ProjectRow, [string]>(`
    select ${PROJECT_COLUMNS} from projects p left join project_holds h on h.project_id=p.id where p.cwd = ?
  `).get(cwd);
  if (!row) return null;
  return attachAgentProfiles(db, [mapProjectRow(row)])[0] ?? null;
}

function mapProjectRow(row: ProjectRow): Project {
  const provider = normalizeProjectProvider(row.provider);
  const storedPolicy = readStoredExecutionPolicy({
    approvalPolicy: row.approval_policy,
    json: row.execution_policy_json,
    sandbox: row.sandbox,
    scope: "project"
  });
  return {
    id: requiredString(row.id, "projects.id"),
    name: requiredString(row.name, "projects.name"),
    pi_managed: integerValue(row.pi_managed, "projects.pi_managed"),
    cwd: requiredString(row.cwd, "projects.cwd"),
    provider,
    provider_config_json: normalizeProjectProviderConfig(row.provider_config_json),
    auto_run: integerValue(row.auto_run, "projects.auto_run"),
    model: normalizeProjectModel(row.model, provider),
    approval_policy: optionalString(row.approval_policy, "never"),
    sandbox: optionalString(row.sandbox, "workspace-write"),
    execution_policy: storedPolicy.policy!,
    execution_policy_json: optionalString(row.execution_policy_json, "{}"),
    execution_policy_source: storedPolicy.source,
    execution_policy_warnings: storedPolicy.warnings,
    default_agent_profile_id: optionalString(row.default_agent_profile_id),
    default_mcp_policy: optionalString(row.default_mcp_policy_json, "{}"),
    default_service_tier: optionalString(row.default_service_tier),
    default_skill_policy: optionalString(row.default_skill_policy_json, "{}"),
    sort_order: integerValue(row.sort_order, "projects.sort_order"),
    created_at: requiredString(row.created_at, "projects.created_at"),
    updated_at: requiredString(row.updated_at, "projects.updated_at"),
    ...(projectHold(row) ? { hold: projectHold(row) } : {}),
    loop_status: "stopped",
    provider_capabilities: providerCapabilities(row.provider)
  };
}

export class ProjectNotFoundError extends Error {
  constructor() {
    super("资源不存在");
    this.name = "ProjectNotFoundError";
  }
}

function validateProjectForWrite(id: string, cwd: string): void {
  if (id === "") throw new Error("project id 不能为空");
  if (cwd === "") throw new Error("cwd 不能为空");
  validateProjectCWD(cwd);
}

function validateProjectCWD(cwd: string): void {
  try {
    if (!statSync(cwd).isDirectory()) throw new Error("cwd 不是目录");
  } catch (error) {
    if (error instanceof Error && error.message === "cwd 不是目录") throw error;
    throw new Error("cwd 不存在");
  }
}

function mustGetProject(db: RunnerDatabase, id: string): Project {
  const project = getProject(db, id);
  if (!project) throw new ProjectNotFoundError();
  return project;
}

function nextProjectSortOrder(db: RunnerDatabase): number {
  const row = db.sqlite.query<{ value: number }, []>(
    "select coalesce(max(sort_order), 0) + 1 as value from projects"
  ).get();
  return row?.value ?? 1;
}

function projectToWriteShape(project: Project): NormalizedProjectWrite {
  return {
    id: project.id,
    name: project.name,
    cwd: project.cwd,
    provider: project.provider,
    provider_config_json: project.provider_config_json,
    auto_run: project.auto_run,
    model: project.model,
    approval_policy: project.approval_policy,
    sandbox: project.sandbox,
    execution_policy_json: project.execution_policy_json,
    default_agent_profile_id: project.default_agent_profile_id,
    default_service_tier: project.default_service_tier,
    default_mcp_policy: project.default_mcp_policy,
    default_skill_policy: project.default_skill_policy
  };
}

function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
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

function attachAgentProfiles(db: RunnerDatabase, projects: Project[]): Project[] {
  return projects.map((project) => {
    const profileID = project.default_agent_profile_id.trim();
    if (profileID === "") return project;
    const profile = getAgentProfile(db, profileID);
    return profile ? { ...project, default_agent_profile: profile } : project;
  });
}

function projectHold(row: ProjectRow): ProjectHold | undefined {
  if (optionalString(row.reason) === "") return undefined;
  return {
    reason: optionalString(row.reason),
    message: optionalString(row.message),
    hold_since: optionalString(row.hold_since),
    next_check_at: optionalString(row.next_check_at),
    last_check_at: optionalString(row.last_check_at),
    last_check_error: optionalString(row.last_check_error)
  };
}

function providerCapabilities(value: unknown): string[] {
  switch (normalizeProjectProvider(value)) {
    case "codex":
      return ["issue_execution", "sessions", "resume_session", "interrupt", "approvals", "model_list"];
    case "claude":
      return ["issue_execution", "sessions", "resume_session", "interrupt"];
    case "fake-execution-only":
      return ["issue_execution"];
    default:
      return [];
  }
}
