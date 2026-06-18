import type { RunnerDatabase } from "../db/database.ts";
import type { PiDelegation } from "../db/repositories/pi.ts";
import type { PiActionEnvelope } from "./actionGate.ts";
import type { PiGatePolicy } from "./actionGate.ts";
import type { PiMemoryContextItem } from "./memoryContext.ts";
import type { ProjectStatusSnapshot } from "./projectSnapshot.ts";

export type HeartbeatKind = "project" | "delegation" | "session_watchdog" | "cron" | "provider_health" | "daily_summary";
export type HeartbeatActionCandidate = PiActionEnvelope;
export type HeartbeatIssueRunSignal = {
  attempt: number;
  ended_at: string;
  error: string;
  exit_reason: string;
  issue_id: number;
  provider: string;
  provider_session_id: string;
  run_id: string;
  runtime_metadata: unknown;
  started_at: string;
  status: string;
};
export type HeartbeatAgentSessionSignal = {
  agent_role: string;
  issue_id: number;
  provider: string;
  provider_session_id: string;
  raw_ref: unknown;
  session_key: string;
  status: string;
  title: string;
  updated_at: string;
};
export type HeartbeatProjectSettingsSignal = {
  pi_policy?: {
    allowed_supervisor_actions?: string[];
    concurrency_policy: Record<string, unknown>;
    default_mode: string;
    quiet_hours: Record<string, unknown>;
    retry_policy: Record<string, unknown>;
    supervisor_cooldown_seconds?: number;
    supervisor_max_recoveries_per_issue?: number;
    supervisor_max_recoveries_per_project_per_hour?: number;
    supervisor_mode?: string;
    supervisor_rate_limit_wait_policy?: string;
    timezone: string;
    verification_policy: Record<string, unknown>;
    working_hours: Record<string, unknown>;
  };
  pi_settings: {
    auto_enqueue: number;
    auto_manage: number;
    auto_triage: number;
    max_actions_per_cycle: number;
    notify_on_needs_user: number;
    pi_agent_id: string;
  } | null;
  project: {
    approval_policy: string;
    auto_run: number;
    cwd: string;
    default_agent_profile_id: string;
    default_mcp_policy: unknown;
    default_skill_policy: unknown;
    id: string;
    model: string;
    name: string;
    provider: string;
    provider_config: unknown;
    sandbox: string;
  };
};
export type HeartbeatSupervisorCandidateSignal = {
  allowed_actions?: string[];
  budget_remaining: number;
  cooldown_until?: string;
  diagnosis_code: string;
  evidence_refs: string[];
  issue_status?: string;
  issue_updated_at?: string;
  issue_id: number;
  project_id: string;
  project_budget_remaining?: number;
  provider?: string;
  provider_error_category: string;
  provider_session_id: string;
  provider_turn_id?: string;
  ready: boolean;
  reason: string;
  run_ended_at?: string;
  run_id: string;
  run_status?: string;
  session_status?: string;
  session_turn_id?: string;
  session_updated_at?: string;
  stale_gap_seconds: number;
  supervisor_mode?: string;
  wait_until: string;
};
export type HeartbeatSupervisorRetryWindowSignal = {
  diagnosis_code: string;
  issue_id: number;
  project_id: string;
  provider_error_category: string;
  reason: string;
  retry_after_at: string;
};
export type HeartbeatSupervisorBudgetSignal = {
  attempts_24h: number;
  budget_remaining: number;
  issue_id: number;
  project_budget_remaining: number;
  project_id: string;
};
export type HeartbeatStaleSessionDiagnostic = {
  issue_id: number;
  project_id: string;
  provider_session_id: string;
  run_id: string;
  run_state: string;
  stale_gap_seconds: number;
  status: string;
  updated_at: string;
};
export type HeartbeatSupervisorSignals = {
  candidates: HeartbeatSupervisorCandidateSignal[];
  provider_retry_windows: HeartbeatSupervisorRetryWindowSignal[];
  recovery_budget: HeartbeatSupervisorBudgetSignal[];
  stale_session_diagnostics: HeartbeatStaleSessionDiagnostic[];
};
export type HeartbeatSignals = {
  agent_sessions: {
    recent: HeartbeatAgentSessionSignal[];
    status_counts: Record<string, number>;
    total: number;
  };
  cron: { active: number; due: number; total: number };
  delegations: { active: number; due: number };
  issues: { status_counts: Record<string, number>; total: number };
  issue_runs: {
    open: number;
    recent: HeartbeatIssueRunSignal[];
    status_counts: Record<string, number>;
    total: number;
  };
  memory: { active: number; pinned: number };
  memory_items?: PiMemoryContextItem[];
  pi_conversations: { active: number; total: number };
  project?: ProjectStatusSnapshot;
  project_settings: HeartbeatProjectSettingsSignal;
  provider_health: { provider: string; status: string };
  supervisor: HeartbeatSupervisorSignals;
  usage_cost: { status: string; total_tokens: number };
};
export type HeartbeatPolicy = {
  authorization?: PiGatePolicy;
  authorization_summary?: Record<string, unknown>;
  executor_busy: boolean;
  paused: boolean;
  propose_only: boolean;
};
export type HeartbeatActionSummary = {
  action_id: string;
  action_type: string;
  decision?: string;
  issue_id?: number;
  requires_confirmation?: boolean;
  risk_level?: string;
  status: string;
};
export type HeartbeatResult = {
  action_candidates: HeartbeatActionCandidate[];
  action_results?: HeartbeatActionSummary[];
  actions_proposed: number;
  delegation_id: string;
  error: string;
  executed_actions: string[];
  heartbeat_id: string;
  kind: HeartbeatKind;
  next_tick_at: string;
  policy: HeartbeatPolicy;
  project_id: string;
  signals: HeartbeatSignals;
  skip_reason?: string;
  status: "completed" | "failed" | "skipped";
};
export type HeartbeatInput = {
  collectSignals?: (input: { database: RunnerDatabase; now: Date; projectID: string }) => HeartbeatSignals | Promise<HeartbeatSignals>;
  database: RunnerDatabase;
  delegation?: PiDelegation;
  kind?: HeartbeatKind;
  now?: Date;
  projectID: string;
  trigger?: string;
};
export type DelegationHeartbeatResult = {
  runs: HeartbeatResult[];
  scanned: number;
  skipped: number;
  started: number;
};
export type DelegationHeartbeatInput = {
  database: RunnerDatabase;
  now?: Date;
};
