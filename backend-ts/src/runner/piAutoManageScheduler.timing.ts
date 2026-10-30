import type { PiAutoManageCycleInput, ScheduleTiming } from "./piAutoManageScheduler.model.ts";

export let scheduleCycleSequence = 0;

export const SLOW_SCHEDULE_PHASE_MS = 250;

export type ScheduleCycleTiming = {
  cycleID: string;
  input: PiAutoManageCycleInput;
  kind: ScheduleTiming["cycle_kind"];
  startedAt: string;
};

export async function timedSchedulePhase<T>(
  cycle: ScheduleCycleTiming,
  phase: string,
  operation: () => T | Promise<T>
): Promise<T> {
  // A maintenance cycle contains many synchronous SQLite projections. Yield
  const queuedAt = performance.now();
  await Bun.sleep(0);
  const startedAt = performance.now();
  let result: T | undefined;
  let status: ScheduleTiming["status"] = "succeeded";
  try {
    result = await operation();
    return result;
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    const operationMs = performance.now() - startedAt;
    const postYieldStartedAt = performance.now();
    await Bun.sleep(0);
    const finishedAt = performance.now();
    const summary = resultSummary(result);
    const timing: ScheduleTiming = {
      cycle_id: cycle.cycleID,
      cycle_kind: cycle.kind,
      duration_ms: finishedAt - queuedAt,
      operation_ms: operationMs,
      phase,
      post_yield_ms: finishedAt - postYieldStartedAt,
      queue_wait_ms: startedAt - queuedAt,
      ...(summary ? { result: summary } : {}),
      started_at: cycle.startedAt,
      status
    };
    cycle.input.scheduleTimingObserver?.(timing);
    if (timing.duration_ms >= SLOW_SCHEDULE_PHASE_MS) logScheduleTiming(timing);
  }
}

export function logScheduleTiming(timing: ScheduleTiming): void {
  console.warn(JSON.stringify({
    event: "runner.schedule_phase_slow",
    ...roundedTiming(timing)
  }));
}

export function logCycleTiming(cycle: ScheduleCycleTiming, phase: string, durationMs: number): void {
  const timing: ScheduleTiming = {
    cycle_id: cycle.cycleID,
    cycle_kind: cycle.kind,
    duration_ms: durationMs,
    operation_ms: durationMs,
    phase,
    post_yield_ms: 0,
    queue_wait_ms: 0,
    started_at: cycle.startedAt,
    status: "succeeded"
  };
  cycle.input.scheduleTimingObserver?.(timing);
  logScheduleTiming(timing);
}

export function scheduleCycleTiming(input: PiAutoManageCycleInput, kind: ScheduleTiming["cycle_kind"]): ScheduleCycleTiming {
  const startedAt = new Date().toISOString();
  scheduleCycleSequence += 1;
  return { cycleID: `${kind}:${startedAt}:${scheduleCycleSequence}`, input, kind, startedAt };
}

export function resultSummary(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const summary = Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => typeof item === "number" && Number.isFinite(item))
    .slice(0, 16)) as Record<string, number>;
  return Object.keys(summary).length > 0 ? summary : undefined;
}

export function roundedTiming(timing: ScheduleTiming): ScheduleTiming {
  return {
    ...timing,
    duration_ms: Math.round(timing.duration_ms),
    operation_ms: Math.round(timing.operation_ms),
    post_yield_ms: Math.round(timing.post_yield_ms),
    queue_wait_ms: Math.round(timing.queue_wait_ms)
  };
}
