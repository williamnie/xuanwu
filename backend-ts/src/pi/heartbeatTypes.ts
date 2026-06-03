import type { RunnerDatabase } from "../db/database.ts";
import type { PiDelegation } from "../db/repositories/pi.ts";
import type { PiActionEnvelope } from "./actionGate.ts";
import type { PiGatePolicy } from "./actionGate.ts";
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
  memory_items?: Array<{ confidence: string; content: string; kind: string; scope: string; scope_id: string }>;
  pi_conversations: { active: number; total: number };
  project?: ProjectStatusSnapshot;
  project_settings: HeartbeatProjectSettingsSignal;
  provider_health: { provider: string; status: string };
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
