import type { RunnerDatabase } from "../db/database.ts";
import type { PiDelegation } from "../db/repositories/pi.ts";
import type { PiActionEnvelope } from "./actionGate.ts";
import type { ProjectStatusSnapshot } from "./projectSnapshot.ts";

export type HeartbeatKind = "project" | "delegation" | "session_watchdog" | "cron" | "provider_health" | "daily_summary";
export type HeartbeatActionCandidate = PiActionEnvelope;
export type HeartbeatSignals = {
  cron: { active: number; due: number; total: number };
  delegations: { active: number; due: number };
  issues: { status_counts: Record<string, number>; total: number };
  memory: { active: number; pinned: number };
  memory_items?: Array<{ confidence: string; content: string; kind: string; scope: string; scope_id: string }>;
  pi_conversations: { active: number; total: number };
  project?: ProjectStatusSnapshot;
  provider_health: { provider: string; status: string };
  usage_cost: { status: string; total_tokens: number };
};
export type HeartbeatPolicy = {
  executor_busy: boolean;
  paused: boolean;
  propose_only: boolean;
};
export type HeartbeatResult = {
  action_candidates: HeartbeatActionCandidate[];
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
  collectSignals?: (input: { database: RunnerDatabase; now: Date; projectID: string }) => HeartbeatSignals;
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
