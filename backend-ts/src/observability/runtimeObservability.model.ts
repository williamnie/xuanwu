

export const RUNTIME_OBSERVABILITY_SCHEMA_VERSION = "xuanwu.runtime-observability.v1" as const;

export const RUNTIME_OBSERVABILITY_CACHE_TTL_MS = 15_000;

export const runtimeObservabilityCache = new Map<string, {
  expiresAt: number;
  refreshing?: Promise<void>;
  value: Record<string, unknown>;
}>();

export const RUNTIME_OBSERVABILITY_WORKER_TIMEOUT_MS = 30_000;

export type CountRow = { count: number; key: string };

export type WorkflowRow = { runs: number; updated_at: string; work: number; workflow_ref: string };

export type ProviderRow = {
  attempts: number;
  known_usage_attempts: number;
  provider: string;
  total_tokens: number;
};

export type MoneyRow = { amount_micros: number; attempts: number; currency: string; provider: string };

export type ProviderMetric = ProviderRow & { money_by_currency: Array<Omit<MoneyRow, "provider">> };

export type TraceRow = {
  attempt_count: number;
  automation_id: string | null;
  automation_run_id: string | null;
  ended_at: string;
  issue_id: number;
  project_id: string;
  provider: string;
  provider_invocation_ref: string;
  provider_session_id: string;
  run_id: string;
  run_status: string;
  started_at: string;
  usage_completeness: string;
  total_tokens: number;
  work_id: string;
  workflow_ref: string;
};

export type EventRow = {
  event_created_at: string;
  event_type: string;
  issue_id: number;
  project_id: string;
  run_id: string;
  source_event_id: number;
  summary: string;
  summary_payload: string;
};
