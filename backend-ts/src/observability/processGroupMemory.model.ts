import type { CodexProcessOwnership, ProcessTreeEntry } from "../providers/codex/processLifecycle.ts";
import type { AgenticActivitySnapshot } from "../agentic/protocol.ts";

export const PROCESS_GROUP_MEMORY_CONTRACT = "runner-process-group-memory.v1" as const;

export const PROCESS_GROUP_MEMORY_SAMPLE_INTERVAL_MS = 1_000;

export const PROCESS_GROUP_MEMORY_FRESHNESS_MS = 5_000;

export const PROCESS_GROUP_MEMORY_AGENTIC_IDLE_GRACE_MS = 90_000;

export const PROCESS_GROUP_MEMORY_MAINTENANCE_IDLE_GRACE_MS = 5_000;

export const PROCESS_GROUP_MEMORY_RECLAIM_MIN_INTERVAL_MS = 5 * 60_000;

export const PROCESS_GROUP_MEMORY_METRIC_DEFINITIONS = {
  footprint_bytes: "macOS footprint (phys_footprint) from non-suspending proc_pid_rusage, summed per observed PID",
  process_rss_bytes: "process.memoryUsage().rss for the runner main process only",
  ps_rss_bytes: "resident set reported by macOS ps for each runner descendant; process-group values are summed",
  probes_excluded: ["ps", "/usr/bin/footprint"]
} as const;

export const PROCESS_GROUP_MEMORY_BUDGETS = {
  alert_after_ms: { hard: 3 * 60_000, soft: 3 * 60_000 },
  consecutive: { hard: 180, soft: 180 },
  idle_main_rss_bytes: { hard: 384 * 1024 * 1024, soft: 320 * 1024 * 1024 },
  idle_group_rss_p95_bytes: { hard: 448 * 1024 * 1024, soft: 384 * 1024 * 1024 },
  active_run_group_rss_p95_bytes: { hard: 896 * 1024 * 1024, soft: 768 * 1024 * 1024 },
  post_run_delta_bytes: { hard: 96 * 1024 * 1024, soft: 64 * 1024 * 1024 },
  soak_drift_bytes: { hard: 128 * 1024 * 1024, soft: 96 * 1024 * 1024 }
} as const;

export type ProcessMemoryPhase = "idle" | "run" | "usage";

export type ProcessMemoryBudgetLevel = "hard" | "soft";

export type ProcessMemoryBudgetAlert = {
  budget: Record<string, unknown>;
  level: ProcessMemoryBudgetLevel;
  phase: ProcessMemoryPhase;
  sample: Record<string, unknown>;
};

export type ProcessMemoryBudgetRecovery = {
  budget: Record<string, unknown>;
  phase: ProcessMemoryPhase;
  sampled_at: string;
};

export type RuntimeOwnership = { idle_ttl_ms?: number; owners: string[]; process?: CodexProcessOwnership } | undefined;

export type ProcessMemoryUsage = ReturnType<typeof process.memoryUsage>;

export type ProcessGroupMemoryOptions = {
  activeRuns?: () => number;
  agenticActivity?: () => AgenticActivitySnapshot;
  agenticIdleGraceMs?: number;
  footprint?: false | ((pids: number[]) => Promise<Map<number, number>>);
  footprintIntervalMs?: number;
  inspect?: () => ProcessTreeEntry[];
  maintenanceIdleGraceMs?: number;
  memoryUsage?: () => ProcessMemoryUsage;
  now?: () => Date;
  onAlert?: (alert: ProcessMemoryBudgetAlert) => void;
  onRecovery?: (recovery: ProcessMemoryBudgetRecovery) => void;
  providerRuntime?: () => RuntimeOwnership;
  reclaimMemory?: () => void;
  reclaimMinIntervalMs?: number;
  runnerPid?: number;
  sampleIntervalMs?: number;
};

export type ObservedProcess = ProcessTreeEntry & {
  identity: string;
  owner: string;
  role: string;
  started_at: string;
};

export type FootprintMeasurementSource = "footprint" | "footprint+rss" | "rss";

export type FootprintState = {
  bytes: number;
  by_identity: Map<string, number>;
  main_bytes: number;
  observed_at: string;
  process_count: number;
};
