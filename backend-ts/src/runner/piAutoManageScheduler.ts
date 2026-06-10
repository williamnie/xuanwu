import type { RunnerDatabase } from "../db/database.ts";
import type { RunnerConfig } from "../config/env.ts";
import { isPiHeartbeatPaused } from "../db/repositories/pi.ts";
import type { EventBus } from "../events/bus.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { runDelegationHeartbeatsOnce } from "../pi/heartbeatOrchestrator.ts";
import { runPiIssueSupervisorSchedulerOnce } from "./piIssueSupervisorScheduler.ts";
import { runDueCronTasks } from "./cronExecutor.ts";

export type PiAutoManageProjectCycleInput = { maxActions: number; projectId: string };
export type PiAutoManageProjectCycle = (input: PiAutoManageProjectCycleInput) => Promise<unknown>;
export type PiAutoManageCycleResult = { projects: number; skipped: number; started: number };
export type ScheduleLayerCycleResult = PiAutoManageCycleResult & {
  cron: { executed: number; failed: number; scanned: number; skipped: number };
  delegations: { scanned: number; skipped: number; started: number };
  supervisor: { decisions: number; failed: number; scanned: number; signaled: number; skipped: number };
};

export type PiAutoManageCycleInput = {
  bus?: EventBus;
  codexSessionsDir?: string;
  config?: RunnerConfig;
  database: RunnerDatabase;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  runProjectCycle: PiAutoManageProjectCycle;
  runSupervisor?: boolean;
};

export type PiAutoManageSchedulerClock<Timer = unknown> = {
  clearTimeout(timer: Timer): void;
  setTimeout(callback: () => void, delayMs: number): Timer;
};

export type PiAutoManageSchedulerInput<Timer = unknown> = PiAutoManageCycleInput & {
  clock?: PiAutoManageSchedulerClock<Timer>;
  intervalMs?: number;
  onError?: (error: unknown) => void;
  supervisorIntervalMs?: number;
};

export type PiAutoManageScheduler = {
  start(): void;
  stop(): void;
};

type EnabledProjectRow = { max_actions_per_cycle: number; project_id: string };

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_SUPERVISOR_INTERVAL_MS = 60_000;
const activeProjectCycles = new Set<string>();

export function createPiAutoManageScheduler<Timer = unknown>(
  input: PiAutoManageSchedulerInput<Timer>
): PiAutoManageScheduler {
  const clock = input.clock ?? defaultClock<Timer>();
  const intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;
  const supervisorIntervalMs = input.supervisorIntervalMs ?? DEFAULT_SUPERVISOR_INTERVAL_MS;
  let lastSupervisorScanAt = 0;
  let timer: Timer | undefined;
  let stopped = true;

  const schedule = () => {
    timer = clock.setTimeout(tick, intervalMs);
  };
  const tick = () => {
    const now = Date.now();
    const runSupervisor = shouldRunSupervisor(now, lastSupervisorScanAt, supervisorIntervalMs);
    if (runSupervisor) lastSupervisorScanAt = now;
    void runScheduleLayerCycle({ ...input, runSupervisor }).catch((error) => {
      input.onError?.(error);
    }).finally(() => {
      if (!stopped) schedule();
    });
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      schedule();
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
    }
  };
}

export async function runPiAutoManageCycle(input: PiAutoManageCycleInput): Promise<PiAutoManageCycleResult> {
  const projects = listAutoManagedProjects(input.database);
  const result: PiAutoManageCycleResult = { projects: projects.length, skipped: 0, started: 0 };
  for (const project of projects) {
    if (isProjectHeartbeatPaused(input.database, project.project_id)) {
      result.skipped += 1;
      continue;
    }
    if (activeProjectCycles.has(project.project_id)) {
      result.skipped += 1;
      continue;
    }
    await runManagedProjectCycle(input.runProjectCycle, project);
    result.started += 1;
  }
  return result;
}

export async function runScheduleLayerCycle(input: PiAutoManageCycleInput): Promise<ScheduleLayerCycleResult> {
  const supervisor = input.runSupervisor === false
    ? { decisions: 0, failed: 0, scanned: 0, signaled: 0, skipped: 0 }
    : await runPiIssueSupervisorSchedulerOnce({ database: input.database, providers: input.providers });
  const cron = await runDueCronTasks({
    bus: input.bus,
    codexSessionsDir: input.codexSessionsDir,
    config: input.config,
    database: input.database,
    runProjectCycle: input.runProjectCycle
  });
  const delegations = await runDelegationHeartbeatsOnce({ database: input.database });
  const projects = await runPiAutoManageCycle(input);
  return {
    ...projects,
    cron,
    delegations: { scanned: delegations.scanned, skipped: delegations.skipped, started: delegations.started },
    supervisor
  };
}

function shouldRunSupervisor(now: number, lastAt: number, intervalMs: number): boolean {
  return lastAt === 0 || now - lastAt >= intervalMs;
}

export function isProjectHeartbeatPaused(db: RunnerDatabase, projectID: string): boolean {
  return isPiHeartbeatPaused(db, { scopeId: projectID, scopeType: "project" });
}

function listAutoManagedProjects(db: RunnerDatabase): EnabledProjectRow[] {
  return db.sqlite.query<EnabledProjectRow, []>(`
    select s.project_id, s.max_actions_per_cycle
    from project_pi_settings s
    join projects p on p.id = s.project_id
    join pi_agents a on a.id = s.pi_agent_id
    where s.auto_manage = 1 and a.enabled = 1
    order by p.sort_order asc, p.created_at asc, p.id asc
  `).all();
}

async function runManagedProjectCycle(runProjectCycle: PiAutoManageProjectCycle, project: EnabledProjectRow): Promise<void> {
  activeProjectCycles.add(project.project_id);
  try {
    await runProjectCycle({
      maxActions: project.max_actions_per_cycle,
      projectId: project.project_id
    });
  } finally {
    activeProjectCycles.delete(project.project_id);
  }
}

function defaultClock<Timer>(): PiAutoManageSchedulerClock<Timer> {
  return {
    clearTimeout: (timer) => clearTimeout(timer as Timer & ReturnType<typeof setTimeout>),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs) as Timer
  };
}
