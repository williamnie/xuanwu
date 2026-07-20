import { PROCESS_GROUP_MEMORY_BUDGETS } from "../observability/processGroupMemory.ts";
import { APPLICATION_SUPPORT_TARGET_BYTES } from "../artifacts/lifecycle.ts";

export const ENDURANCE_GATE_CONTRACT = "xw.runner-endurance-gate.v1" as const;
export const ENDURANCE_MINIMUM_DURATION_MS = 24 * 60 * 60 * 1000;
export const ENDURANCE_REQUIRED_OPERATIONS = [
  "usage", "run_success", "run_failure", "run_cancel", "run_retry", "archive", "restart"
] as const;
export const ENDURANCE_GROWTH_BUDGETS = {
  artifact_bytes_per_run: 16 * 1024 * 1024,
  database_bytes_per_run: 8 * 1024 * 1024
} as const;

export type EnduranceOperation = typeof ENDURANCE_REQUIRED_OPERATIONS[number] | "idle";
export type EnduranceSample = {
  application_support_bytes: number;
  artifact_bytes: number;
  budget_status: string;
  completed_runs: number;
  database_bytes: number;
  measured_group_bytes: number;
  measured_main_bytes: number;
  measurement_source: string;
  observed_at: string;
  operation: EnduranceOperation;
  orphan_processes: number;
  stale_sessions: number;
};

export function evaluateEnduranceGate(samplesInput: EnduranceSample[]): Record<string, unknown> {
  const samples = [...samplesInput].sort((left, right) => Date.parse(left.observed_at) - Date.parse(right.observed_at));
  const first = samples[0];
  const last = samples.at(-1);
  const duration = first && last ? Math.max(0, Date.parse(last.observed_at) - Date.parse(first.observed_at)) : 0;
  const missingOperations = ENDURANCE_REQUIRED_OPERATIONS.filter((operation) => !samples.some((sample) => sample.operation === operation));
  const sampling = {
    duration_ms: duration,
    minimum_duration_ms: ENDURANCE_MINIMUM_DURATION_MS,
    minimum_samples: 25,
    samples: samples.length,
    status: duration >= ENDURANCE_MINIMUM_DURATION_MS && samples.length >= 25 ? "passed" : "failed"
  };
  const measured = samples.map((sample) => sample.measured_group_bytes);
  const monotonic = measured.length >= 3 && measured.at(-1)! > measured[0]! &&
    measured.every((value, index) => index === 0 || value >= measured[index - 1]!);
  const drift = measured.length < 2 ? 0 : Math.max(0, measured.at(-1)! - measured[0]!);
  const memoryPassed = samples.length > 0 && samples.every((sample) =>
    sample.budget_status === "within_budget" &&
    (sample.measurement_source === "footprint" || sample.measurement_source === "footprint+rss" || sample.measurement_source === "rss")) &&
    !monotonic && drift <= PROCESS_GROUP_MEMORY_BUDGETS.soak_drift_bytes.hard;
  const completedRuns = first && last ? last.completed_runs - first.completed_runs : 0;
  const databaseGrowth = first && last ? Math.max(0, last.database_bytes - first.database_bytes) : 0;
  const artifactGrowth = first && last ? Math.max(0, last.artifact_bytes - first.artifact_bytes) : 0;
  const databasePerRun = completedRuns > 0 ? databaseGrowth / completedRuns : Number.POSITIVE_INFINITY;
  const artifactPerRun = completedRuns > 0 ? artifactGrowth / completedRuns : Number.POSITIVE_INFINITY;
  const growthPassed = completedRuns > 0 &&
    databasePerRun <= ENDURANCE_GROWTH_BUDGETS.database_bytes_per_run &&
    artifactPerRun <= ENDURANCE_GROWTH_BUDGETS.artifact_bytes_per_run;
  const lifecyclePassed = missingOperations.length === 0 && samples.every((sample) => sample.orphan_processes === 0 && sample.stale_sessions === 0);
  const capacityPassed = Boolean(last && last.application_support_bytes <= APPLICATION_SUPPORT_TARGET_BYTES);
  const status = sampling.status === "passed" && memoryPassed && growthPassed && lifecyclePassed && capacityPassed ? "passed" : "failed";
  return {
    application_support: {
      final_bytes: last?.application_support_bytes ?? null,
      target_bytes: APPLICATION_SUPPORT_TARGET_BYTES,
      status: capacityPassed ? "passed" : "failed"
    },
    contract: ENDURANCE_GATE_CONTRACT,
    growth: {
      artifact_bytes: artifactGrowth,
      artifact_bytes_per_run: finiteOrNull(artifactPerRun),
      budgets: ENDURANCE_GROWTH_BUDGETS,
      completed_runs: completedRuns,
      database_bytes: databaseGrowth,
      database_bytes_per_run: finiteOrNull(databasePerRun),
      status: growthPassed ? "passed" : "failed"
    },
    lifecycle: {
      missing_operations: missingOperations,
      orphan_processes_max: maximum(samples.map((sample) => sample.orphan_processes)),
      stale_sessions_max: maximum(samples.map((sample) => sample.stale_sessions)),
      status: lifecyclePassed ? "passed" : "failed"
    },
    memory: {
      drift_bytes: drift,
      drift_hard_bytes: PROCESS_GROUP_MEMORY_BUDGETS.soak_drift_bytes.hard,
      monotonic_growth: monotonic,
      status: memoryPassed ? "passed" : "failed"
    },
    sampling,
    status
  };
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function maximum(values: number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}
