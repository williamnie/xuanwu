import { cleanString } from "../../util/values.ts";

export type IssueFilter = {
  cursorIssueId?: number;
  cursorUpdatedAt?: string;
  limit?: number;
  offset?: number;
  projectId?: string;
  query?: string;
  sort?: "created_at" | "status" | "title" | "updated_at";
  sortOrder?: "asc" | "desc";
  source?: "github" | "manual";
  sourceSessionId?: string;
  status?: string;
  statuses?: string[];
};

export type IssueRow = {
  agent_profile_id: unknown;
  attempt_count: unknown;
  auto_retry_next_at: unknown;
  auto_retry_reason: unknown;
  codex_thread_id: unknown;
  codex_turn_id: unknown;
  comment_count: unknown;
  created_at: unknown;
  description: unknown;
  error: unknown;
  id: unknown;
  issue_log_mode: unknown;
  priority: unknown;
  project_id: unknown;
  recommended_mcp_capabilities_json: unknown;
  recommended_skill_intents_json: unknown;
  required_mcp_capabilities_json: unknown;
  required_skill_intents_json: unknown;
  service_tier: unknown;
  source_excerpt: unknown;
  source_session_id: unknown;
  source_turn_id: unknown;
  status: unknown;
  title: unknown;
  updated_at: unknown;
  workflow_snapshot_json: unknown;
};

export type IssueRunRow = {
  agent_profile_id: unknown;
  attempt: unknown;
  capability_summary: unknown;
  codex_thread_id: unknown;
  codex_turn_id: unknown;
  ended_at: unknown;
  error: unknown;
  exit_reason: unknown;
  git_base_revision: unknown;
  id: unknown;
  issue_id: unknown;
  provider: unknown;
  provider_session_id: unknown;
  provider_turn_id: unknown;
  runtime_metadata_json: unknown;
  skill_intent_audit_json: unknown;
  selection_reason: unknown;
  started_at: unknown;
  status: unknown;
};

export type IssueRun = {
  agent_profile_id: string;
  attempt: number;
  capability_summary: string;
  codex_thread_id: string;
  codex_turn_id: string;
  ended_at: string;
  error: string;
  git_base_revision: string;
  exit_reason: string;
  id: string;
  issue_id: number;
  provider: string;
  provider_session_id: string;
  provider_turn_id: string;
  runtime_metadata_json: string;
  skill_intent_audit_json: string;
  selection_reason: string;
  started_at: string;
  status: string;
};

export type Issue = {
  agent_profile_id: string;
  attempt_count: number;
  auto_retry_next_at: string;
  auto_retry_reason: string;
  codex_thread_id: string;
  codex_turn_id: string;
  comment_count: number;
  created_at: string;
  description: string;
  error: string;
  id: number;
  issue_log_mode: "debug" | "normal";
  latest_run?: IssueRun;
  priority: number;
  project_id: string;
  recommended_mcp_capabilities: string;
  recommended_skill_intents: string;
  required_mcp_capabilities: string;
  required_skill_intents: string;
  service_tier: string;
  source_excerpt: string;
  source_session_id: string;
  source_turn_id: string;
  status: string;
  title: string;
  updated_at: string;
  workflow_snapshot_json: string;
};

export const ISSUE_COLUMNS = `id, project_id, title, description, status, priority,
  required_skill_intents_json, recommended_skill_intents_json,
  required_mcp_capabilities_json, recommended_mcp_capabilities_json, agent_profile_id, source_session_id,
  source_turn_id, source_excerpt, codex_thread_id, codex_turn_id, service_tier,
  attempt_count,
  issue_log_mode,
  (select count(*) from issue_events where issue_id=issues.id and type='issue.comment') as comment_count,
  workflow_snapshot_json, auto_retry_next_at, auto_retry_reason, error,
  created_at, updated_at`;

export const ISSUE_RUN_COLUMNS = `ir.id, ir.issue_id, ir.attempt, ir.status, ir.provider,
  ir.provider_session_id, ir.provider_turn_id, ir.codex_thread_id, ir.codex_turn_id,
  ir.started_at, ir.ended_at, ir.exit_reason, ir.error, ir.agent_profile_id,
  ir.capability_summary, ir.selection_reason, ir.runtime_metadata_json, ir.skill_intent_audit_json,
  ir.git_base_revision`;

export function mapIssueRow(row: IssueRow): Issue {
  return {
    id: positiveInteger(row.id, "issues.id"),
    project_id: requiredString(row.project_id, "issues.project_id"),
    title: requiredString(row.title, "issues.title"),
    description: rawString(row.description),
    status: requiredString(row.status, "issues.status"),
    priority: integerValue(row.priority, "issues.priority"),
    required_skill_intents: optionalString(row.required_skill_intents_json, "[]"),
    recommended_skill_intents: optionalString(row.recommended_skill_intents_json, "[]"),
    required_mcp_capabilities: optionalString(row.required_mcp_capabilities_json, "[]"),
    recommended_mcp_capabilities: optionalString(row.recommended_mcp_capabilities_json, "[]"),
    service_tier: optionalString(row.service_tier),
    agent_profile_id: optionalString(row.agent_profile_id),
    source_session_id: optionalString(row.source_session_id),
    source_turn_id: optionalString(row.source_turn_id),
    source_excerpt: optionalString(row.source_excerpt),
    codex_thread_id: optionalString(row.codex_thread_id),
    codex_turn_id: optionalString(row.codex_turn_id),
    attempt_count: integerValue(row.attempt_count, "issues.attempt_count"),
    issue_log_mode: issueLogMode(row.issue_log_mode),
    comment_count: integerValue(row.comment_count, "issues.comment_count"),
    workflow_snapshot_json: optionalString(row.workflow_snapshot_json),
    auto_retry_next_at: optionalString(row.auto_retry_next_at),
    auto_retry_reason: optionalString(row.auto_retry_reason),
    error: optionalString(row.error),
    created_at: requiredString(row.created_at, "issues.created_at"),
    updated_at: requiredString(row.updated_at, "issues.updated_at")
  };
}

function issueLogMode(value: unknown): "debug" | "normal" {
  return optionalString(value, "normal") === "debug" ? "debug" : "normal";
}

export function mapIssueRunRow(row: IssueRunRow): IssueRun {
  return {
    id: requiredString(row.id, "issue_runs.id"),
    issue_id: positiveInteger(row.issue_id, "issue_runs.issue_id"),
    attempt: positiveInteger(row.attempt, "issue_runs.attempt"),
    status: requiredString(row.status, "issue_runs.status"),
    provider: optionalString(row.provider, "codex"),
    provider_session_id: optionalString(row.provider_session_id),
    provider_turn_id: optionalString(row.provider_turn_id),
    codex_thread_id: optionalString(row.codex_thread_id),
    codex_turn_id: optionalString(row.codex_turn_id),
    started_at: requiredString(row.started_at, "issue_runs.started_at"),
    ended_at: optionalString(row.ended_at),
    exit_reason: optionalString(row.exit_reason),
    error: optionalString(row.error),
    git_base_revision: optionalString(row.git_base_revision),
    agent_profile_id: optionalString(row.agent_profile_id),
    capability_summary: optionalString(row.capability_summary),
    selection_reason: optionalString(row.selection_reason),
    runtime_metadata_json: optionalString(row.runtime_metadata_json, "{}"),
    skill_intent_audit_json: optionalString(row.skill_intent_audit_json, "{}")
  };
}

export function normalizeSourceSessionID(value: string | undefined): string {
  const text = cleanString(value);
  if (!text) return "";
  const separator = text.indexOf(":");
  if (separator < 0) return text;
  const provider = text.slice(0, separator).trim().toLowerCase();
  const sessionID = text.slice(separator + 1).trim();
  return provider === "codex" ? sessionID : text;
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

export function positiveInteger(value: unknown, label: string): number {
  const number = integerValue(value, label);
  if (number <= 0) throw new Error(`${label} must be positive`);
  return number;
}

function integerValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return value;
}

function rawString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new Error(`expected string row value`);
  return value;
}
