import { DEFAULT_SUPERVISOR_INTERVAL_MS, GUARDIAN_INITIAL_DELAY_MS, DEFAULT_INTERVAL_MS } from "./piAutoManageScheduler.model.ts";
import type { PiAutoManageSchedulerInput, PiAutoManageScheduler, PiAutoManageSchedulerClock } from "./piAutoManageScheduler.model.ts";
import { withNativeAutomationExecutor, shouldRunSupervisor } from "./piAutoManageScheduler.projects.ts";
import { runScheduleLayerCycle, runGuardianControlPlaneCycle, runAgenticCycle } from "./piAutoManageScheduler.cycles.ts";

export function createPiAutoManageScheduler<Timer = unknown>(
  input: PiAutoManageSchedulerInput<Timer>
): PiAutoManageScheduler {
  const runtimeInput = withNativeAutomationExecutor(input);
  const supervisorIntervalMs = input.supervisorIntervalMs ?? DEFAULT_SUPERVISOR_INTERVAL_MS;
  let lastSupervisorScanAt = 0;
  return createCycleScheduler(input, async () => {
    const now = Date.now();
    const runSupervisor = shouldRunSupervisor(now, lastSupervisorScanAt, supervisorIntervalMs);
    if (runSupervisor) lastSupervisorScanAt = now;
    await runScheduleLayerCycle({ ...runtimeInput, runSupervisor });
  });
}

export function createPiGuardianScheduler<Timer = unknown>(
  input: PiAutoManageSchedulerInput<Timer>
): PiAutoManageScheduler {
  const runtimeInput = withNativeAutomationExecutor(input);
  return createCycleScheduler(
    { initialDelayMs: GUARDIAN_INITIAL_DELAY_MS, ...input },
    () => runGuardianControlPlaneCycle(runtimeInput)
  );
}

export function createPiAgenticScheduler<Timer = unknown>(
  input: PiAutoManageSchedulerInput<Timer>
): PiAutoManageScheduler {
  const supervisorIntervalMs = input.supervisorIntervalMs ?? DEFAULT_SUPERVISOR_INTERVAL_MS;
  let lastSupervisorScanAt = 0;
  return createCycleScheduler(input, async () => {
    const now = Date.now();
    const runSupervisor = shouldRunSupervisor(now, lastSupervisorScanAt, supervisorIntervalMs);
    if (runSupervisor) lastSupervisorScanAt = now;
    await runAgenticCycle({ ...input, runSupervisor });
  });
}

export function createCycleScheduler<Timer>(
  input: PiAutoManageSchedulerInput<Timer>,
  cycle: () => Promise<unknown>
): PiAutoManageScheduler {
  const clock = input.clock ?? defaultClock<Timer>();
  const intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;
  let timer: Timer | undefined;
  let stopped = true;
  const schedule = (delayMs = intervalMs) => { timer = clock.setTimeout(tick, delayMs); };
  const tick = async () => {
    try {
      await (input.runWithinActivity ? input.runWithinActivity(cycle) : cycle());
    } catch (error) {
      input.onError?.(error);
    } finally {
      if (!stopped) schedule();
    }
  };
  return {
    start() {
      if (!stopped) return;
      stopped = false;
      schedule(input.initialDelayMs ?? intervalMs);
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
    }
  };
}

export function defaultClock<Timer>(): PiAutoManageSchedulerClock<Timer> {
  return {
    clearTimeout: (timer) => clearTimeout(timer as Timer & ReturnType<typeof setTimeout>),
    setTimeout: (callback, delayMs) => setTimeout(() => { void callback(); }, delayMs) as Timer
  };
}
