import type { RunnerDatabase } from "../../database.ts";
import { cleanString, getByID, now, requiredString } from "./common.ts";

export type ProjectPiPolicyMode = "manual" | "attended" | "delegated" | "autonomous";
export type ProjectPiRetryPolicy = { enabled: boolean; max_attempts: number; backoff_minutes: number[] };
export type ProjectPiConcurrencyPolicy = { max_parallel_issues: number; max_parallel_pi_cycles: number };
export type ProjectPiVerificationPolicy = {
  evidence_required: boolean;
  on_timeout: "escalate" | "request_verifier";
  pending_timeout_minutes: number;
};
export type ProjectPiPolicy = {
  project_id: string;
  default_mode: ProjectPiPolicyMode;
  timezone: string;
  working_hours_json: string;
  quiet_hours_json: string;
  retry_policy_json: string;
  concurrency_policy_json: string;
  verification_policy_json: string;
  created_at: string;
  updated_at: string;
};
export type ProjectPiPolicyInput = Partial<Record<keyof ProjectPiPolicy, unknown>>;

// project_pi_settings 保持为 agent/auto-manage 执行设置；本表只承载项目 PI 决策 policy。
const TABLE = "project_pi_policies";
const COLUMNS = `project_id, default_mode, timezone, working_hours_json, quiet_hours_json,
  retry_policy_json, concurrency_policy_json, verification_policy_json, created_at, updated_at`;
const MODES = new Set<ProjectPiPolicyMode>(["manual", "attended", "delegated", "autonomous"]);
const TIMEOUT_ACTIONS = new Set(["escalate", "request_verifier"]);
const DEFAULT_RETRY: ProjectPiRetryPolicy = { enabled: false, max_attempts: 0, backoff_minutes: [] };
const DEFAULT_CONCURRENCY: ProjectPiConcurrencyPolicy = { max_parallel_issues: 1, max_parallel_pi_cycles: 1 };
const DEFAULT_VERIFICATION: ProjectPiVerificationPolicy = { pending_timeout_minutes: 24 * 60, on_timeout: "escalate", evidence_required: true };

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
  db.sqlite.run(`insert into ${TABLE} (${COLUMNS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(project_id) do update set default_mode=excluded.default_mode,
      timezone=excluded.timezone, working_hours_json=excluded.working_hours_json,
      quiet_hours_json=excluded.quiet_hours_json, retry_policy_json=excluded.retry_policy_json,
      concurrency_policy_json=excluded.concurrency_policy_json,
      verification_policy_json=excluded.verification_policy_json, updated_at=excluded.updated_at`,
    [record.project_id, record.default_mode, record.timezone, record.working_hours_json,
      record.quiet_hours_json, record.retry_policy_json, record.concurrency_policy_json,
      record.verification_policy_json, current.created_at || timestamp, timestamp]);
  const saved = getProjectPiPolicy(db, projectID);
  if (!saved) throw new Error("project PI policy missing after write");
  return saved;
}

function defaultProjectPiPolicy(projectID: string): ProjectPiPolicy {
  return {
    project_id: cleanString(projectID),
    default_mode: "manual",
    timezone: "UTC",
    working_hours_json: "{}",
    quiet_hours_json: "{}",
    retry_policy_json: JSON.stringify(DEFAULT_RETRY),
    concurrency_policy_json: JSON.stringify(DEFAULT_CONCURRENCY),
    verification_policy_json: JSON.stringify(DEFAULT_VERIFICATION),
    created_at: "",
    updated_at: ""
  };
}

function normalizePolicy(input: ProjectPiPolicyInput): ProjectPiPolicy {
  return {
    project_id: cleanString(input.project_id),
    default_mode: mode(input.default_mode),
    timezone: timezone(input.timezone),
    working_hours_json: jsonObjectText(input.working_hours_json, "{}"),
    quiet_hours_json: jsonObjectText(input.quiet_hours_json, "{}"),
    retry_policy_json: JSON.stringify(retryPolicy(input.retry_policy_json)),
    concurrency_policy_json: JSON.stringify(concurrencyPolicy(input.concurrency_policy_json)),
    verification_policy_json: JSON.stringify(verificationPolicy(input.verification_policy_json)),
    created_at: "",
    updated_at: ""
  };
}

function mapProjectPiPolicy(row: Record<string, unknown>): ProjectPiPolicy {
  return {
    project_id: requiredString(row.project_id, "project_pi_policies.project_id"),
    default_mode: mode(row.default_mode),
    timezone: timezone(row.timezone),
    working_hours_json: jsonObjectText(row.working_hours_json, "{}"),
    quiet_hours_json: jsonObjectText(row.quiet_hours_json, "{}"),
    retry_policy_json: JSON.stringify(retryPolicy(row.retry_policy_json)),
    concurrency_policy_json: JSON.stringify(concurrencyPolicy(row.concurrency_policy_json)),
    verification_policy_json: JSON.stringify(verificationPolicy(row.verification_policy_json)),
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

function verificationPolicy(value: unknown): ProjectPiVerificationPolicy {
  const input = objectValue(value);
  return {
    pending_timeout_minutes: positiveInteger(input.pending_timeout_minutes, DEFAULT_VERIFICATION.pending_timeout_minutes),
    on_timeout: timeoutAction(input.on_timeout),
    evidence_required: input.evidence_required !== false
  };
}

function jsonObjectText(value: unknown, fallback: string): string {
  const object = objectValue(value);
  return Object.keys(object).length > 0 ? JSON.stringify(object) : fallback;
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

function mode(value: unknown): ProjectPiPolicyMode {
  const text = cleanString(value) as ProjectPiPolicyMode;
  return MODES.has(text) ? text : "manual";
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

function timeoutAction(value: unknown): ProjectPiVerificationPolicy["on_timeout"] {
  const text = cleanString(value);
  return TIMEOUT_ACTIONS.has(text) ? text as ProjectPiVerificationPolicy["on_timeout"] : DEFAULT_VERIFICATION.on_timeout;
}

function definedValues(input: ProjectPiPolicyInput): ProjectPiPolicyInput {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null && value !== undefined));
}
