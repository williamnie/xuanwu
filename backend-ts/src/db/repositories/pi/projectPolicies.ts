import type { RunnerDatabase } from "../../database.ts";
import { normalizeMcpCapabilityList } from "../../../mcp/policy.ts";
import {
  PI_SUPERVISOR_RATE_LIMIT_WAIT_POLICIES,
  type PiSupervisorRateLimitWaitPolicy
} from "../../../pi/issueSupervisorRecovery.ts";
import { normalizeSkillIntentList } from "../../../skills/intents.ts";
import { cleanString, getByID, now, requiredString } from "./common.ts";

export type ProjectPiRetryPolicy = { enabled: boolean; max_attempts: number; backoff_minutes: number[] };
export type ProjectPiConcurrencyPolicy = { max_parallel_issues: number; max_parallel_pi_cycles: number };
export type ProjectPiPolicy = {
  project_id: string;
  allowed_actions_json: string;
  allowed_mcp_capabilities_json: string;
  allowed_skill_intents_json: string;
  allowed_supervisor_actions_json: string;
  supervisor_cooldown_seconds: number;
  supervisor_max_recoveries_per_issue: number;
  supervisor_max_recoveries_per_project_per_hour: number;
  supervisor_rate_limit_wait_policy: PiSupervisorRateLimitWaitPolicy;
  timezone: string;
  working_hours_json: string;
  quiet_hours_json: string;
  retry_policy_json: string;
  concurrency_policy_json: string;
  created_at: string;
  updated_at: string;
};
export type ProjectPiPolicyInput = Partial<Record<keyof ProjectPiPolicy, unknown>>;

// project_pi_settings 的记录存在即表示 PI 全自动接管；本表只承载安全与资源 policy。
const TABLE = "project_pi_policies";
const COLUMNS = `project_id, timezone, working_hours_json, quiet_hours_json,
  retry_policy_json, concurrency_policy_json, allowed_actions_json,
  allowed_mcp_capabilities_json, allowed_skill_intents_json, allowed_supervisor_actions_json,
  supervisor_cooldown_seconds, supervisor_max_recoveries_per_issue,
  supervisor_max_recoveries_per_project_per_hour, supervisor_rate_limit_wait_policy,
  created_at, updated_at`;
const WAIT_POLICIES = new Set<PiSupervisorRateLimitWaitPolicy>(PI_SUPERVISOR_RATE_LIMIT_WAIT_POLICIES);
const DEFAULT_RETRY: ProjectPiRetryPolicy = { enabled: false, max_attempts: 0, backoff_minutes: [] };
const DEFAULT_CONCURRENCY: ProjectPiConcurrencyPolicy = { max_parallel_issues: 1, max_parallel_pi_cycles: 1 };
const DEFAULT_SUPERVISOR_ACTIONS = [
  "session.resume_followup",
  "issue.retry_after",
  "issue.retry",
  "issue.state_repair",
  "needs_user.escalate"
];
const ACTION_ID_RE = /^[a-z0-9_.:-]+$/;
const MAX_ACTION_ID_LENGTH = 128;

export function getProjectPiPolicy(db: RunnerDatabase, projectID: string): ProjectPiPolicy | null {
  return getByID(db, TABLE, COLUMNS, projectID, mapProjectPiPolicy, "project_id");
}

export function readProjectPiPolicy(db: RunnerDatabase, projectID: string): ProjectPiPolicy {
  return getProjectPiPolicy(db, projectID) ?? defaultProjectPiPolicy(projectID);
}

export function upsertProjectPiPolicy(db: RunnerDatabase, input: ProjectPiPolicyInput): ProjectPiPolicy {
  const projectID = requiredString(input.project_id, "project_id");
  const current = readProjectPiPolicy(db, projectID);
  const record = normalizePolicy({ ...current, ...definedValues(input), project_id: projectID });
  const timestamp = now();
  db.sqlite.run(`insert into ${TABLE} (${COLUMNS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(project_id) do update set timezone=excluded.timezone, working_hours_json=excluded.working_hours_json,
      quiet_hours_json=excluded.quiet_hours_json, retry_policy_json=excluded.retry_policy_json,
      concurrency_policy_json=excluded.concurrency_policy_json,
      allowed_actions_json=excluded.allowed_actions_json,
      allowed_mcp_capabilities_json=excluded.allowed_mcp_capabilities_json,
      allowed_skill_intents_json=excluded.allowed_skill_intents_json,
      allowed_supervisor_actions_json=excluded.allowed_supervisor_actions_json,
      supervisor_cooldown_seconds=excluded.supervisor_cooldown_seconds,
      supervisor_max_recoveries_per_issue=excluded.supervisor_max_recoveries_per_issue,
      supervisor_max_recoveries_per_project_per_hour=excluded.supervisor_max_recoveries_per_project_per_hour,
      supervisor_rate_limit_wait_policy=excluded.supervisor_rate_limit_wait_policy,
      updated_at=excluded.updated_at`,
    [record.project_id, record.timezone, record.working_hours_json,
      record.quiet_hours_json, record.retry_policy_json, record.concurrency_policy_json,
      record.allowed_actions_json, record.allowed_mcp_capabilities_json,
      record.allowed_skill_intents_json, record.allowed_supervisor_actions_json,
      record.supervisor_cooldown_seconds, record.supervisor_max_recoveries_per_issue,
      record.supervisor_max_recoveries_per_project_per_hour, record.supervisor_rate_limit_wait_policy,
      current.created_at || timestamp, timestamp]);
  const saved = getProjectPiPolicy(db, projectID);
  if (!saved) throw new Error("project PI policy missing after write");
  return saved;
}

function defaultProjectPiPolicy(projectID: string): ProjectPiPolicy {
  return {
    project_id: cleanString(projectID),
    allowed_actions_json: "[]",
    allowed_mcp_capabilities_json: "[]",
    allowed_skill_intents_json: "[]",
    allowed_supervisor_actions_json: JSON.stringify(DEFAULT_SUPERVISOR_ACTIONS),
    supervisor_cooldown_seconds: 300,
    supervisor_max_recoveries_per_issue: 2,
    supervisor_max_recoveries_per_project_per_hour: 10,
    supervisor_rate_limit_wait_policy: "respect_retry_after",
    timezone: "UTC",
    working_hours_json: "{}",
    quiet_hours_json: "{}",
    retry_policy_json: JSON.stringify(DEFAULT_RETRY),
    concurrency_policy_json: JSON.stringify(DEFAULT_CONCURRENCY),
    created_at: "",
    updated_at: ""
  };
}

function normalizePolicy(input: ProjectPiPolicyInput): ProjectPiPolicy {
  return {
    project_id: cleanString(input.project_id),
    allowed_actions_json: actionList(input.allowed_actions_json),
    allowed_mcp_capabilities_json: normalizeMcpCapabilityList(input.allowed_mcp_capabilities_json),
    allowed_skill_intents_json: normalizeSkillIntentList(input.allowed_skill_intents_json),
    allowed_supervisor_actions_json: actionList(input.allowed_supervisor_actions_json),
    supervisor_cooldown_seconds: positiveInteger(input.supervisor_cooldown_seconds, 300),
    supervisor_max_recoveries_per_issue: positiveInteger(input.supervisor_max_recoveries_per_issue, 2),
    supervisor_max_recoveries_per_project_per_hour: positiveInteger(input.supervisor_max_recoveries_per_project_per_hour, 10),
    supervisor_rate_limit_wait_policy: waitPolicy(input.supervisor_rate_limit_wait_policy),
    timezone: timezone(input.timezone),
    working_hours_json: jsonObjectText(input.working_hours_json, "{}"),
    quiet_hours_json: jsonObjectText(input.quiet_hours_json, "{}"),
    retry_policy_json: JSON.stringify(retryPolicy(input.retry_policy_json)),
    concurrency_policy_json: JSON.stringify(concurrencyPolicy(input.concurrency_policy_json)),
    created_at: "",
    updated_at: ""
  };
}

function mapProjectPiPolicy(row: Record<string, unknown>): ProjectPiPolicy {
  return {
    project_id: requiredString(row.project_id, "project_pi_policies.project_id"),
    allowed_actions_json: actionList(row.allowed_actions_json),
    allowed_mcp_capabilities_json: normalizeMcpCapabilityList(row.allowed_mcp_capabilities_json),
    allowed_skill_intents_json: normalizeSkillIntentList(row.allowed_skill_intents_json),
    allowed_supervisor_actions_json: actionList(row.allowed_supervisor_actions_json),
    supervisor_cooldown_seconds: positiveInteger(row.supervisor_cooldown_seconds, 300),
    supervisor_max_recoveries_per_issue: positiveInteger(row.supervisor_max_recoveries_per_issue, 2),
    supervisor_max_recoveries_per_project_per_hour: positiveInteger(row.supervisor_max_recoveries_per_project_per_hour, 10),
    supervisor_rate_limit_wait_policy: waitPolicy(row.supervisor_rate_limit_wait_policy),
    timezone: timezone(row.timezone),
    working_hours_json: jsonObjectText(row.working_hours_json, "{}"),
    quiet_hours_json: jsonObjectText(row.quiet_hours_json, "{}"),
    retry_policy_json: JSON.stringify(retryPolicy(row.retry_policy_json)),
    concurrency_policy_json: JSON.stringify(concurrencyPolicy(row.concurrency_policy_json)),
    created_at: requiredString(row.created_at, "project_pi_policies.created_at"),
    updated_at: requiredString(row.updated_at, "project_pi_policies.updated_at")
  };
}

function retryPolicy(value: unknown): ProjectPiRetryPolicy {
  const input = objectValue(value);
  return {
    enabled: input.enabled === true,
    max_attempts: nonNegativeInteger(input.max_attempts, 0),
    backoff_minutes: positiveIntegerArray(input.backoff_minutes)
  };
}

function concurrencyPolicy(value: unknown): ProjectPiConcurrencyPolicy {
  const input = objectValue(value);
  return {
    max_parallel_issues: positiveInteger(input.max_parallel_issues, 1),
    max_parallel_pi_cycles: positiveInteger(input.max_parallel_pi_cycles, 1)
  };
}

function jsonObjectText(value: unknown, fallback: string): string {
  const object = objectValue(value);
  return Object.keys(object).length > 0 ? JSON.stringify(object) : fallback;
}

function actionList(value: unknown): string {
  return JSON.stringify(cleanActionList(parseActionList(value)));
}

function parseActionList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  const text = cleanString(value);
  if (text === "") return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {}
  return text.split(/[\n,]/);
}

function cleanActionList(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const id = cleanString(value).toLowerCase();
    if (id === "") continue;
    assertValidActionID(id);
    if (!seen.has(id)) out.push(id);
    seen.add(id);
  }
  return out;
}

function assertValidActionID(id: string): void {
  if (id.length > MAX_ACTION_ID_LENGTH || !ACTION_ID_RE.test(id)) {
    throw new Error(`allowed_actions id 不合法: ${id}`);
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  const text = cleanString(value);
  if (text === "") return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function waitPolicy(value: unknown): PiSupervisorRateLimitWaitPolicy {
  const text = cleanString(value) as PiSupervisorRateLimitWaitPolicy;
  return WAIT_POLICIES.has(text) ? text : "respect_retry_after";
}

function timezone(value: unknown): string {
  return cleanString(value) || "UTC";
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function positiveIntegerArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item) => positiveInteger(item, 0) > 0) as number[] : [];
}

function definedValues(input: ProjectPiPolicyInput): ProjectPiPolicyInput {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null && value !== undefined));
}
