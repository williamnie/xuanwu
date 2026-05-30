import type { RunnerDatabase } from "../db/database.ts";

export type PiAutoManageProjectCycleInput = { maxActions: number; projectId: string };
export type PiAutoManageProjectCycle = (input: PiAutoManageProjectCycleInput) => Promise<unknown>;
export type PiAutoManageCycleResult = { projects: number; skipped: number; started: number };

export type PiAutoManageCycleInput = {
  database: RunnerDatabase;
  runProjectCycle: PiAutoManageProjectCycle;
};

export type PiAutoManageSchedulerClock<Timer = unknown> = {
  clearTimeout(timer: Timer): void;
  setTimeout(callback: () => void, delayMs: number): Timer;
};

export type PiAutoManageSchedulerInput<Timer = unknown> = PiAutoManageCycleInput & {
  clock?: PiAutoManageSchedulerClock<Timer>;
  intervalMs?: number;
  onError?: (error: unknown) => void;
};

export type PiAutoManageScheduler = {
  start(): void;
  stop(): void;
};

type EnabledProjectRow = { max_actions_per_cycle: number; project_id: string };

const DEFAULT_INTERVAL_MS = 30_000;
const activeProjectCycles = new Set<string>();

export function createPiAutoManageScheduler<Timer = unknown>(
  input: PiAutoManageSchedulerInput<Timer>
): PiAutoManageScheduler {
  const clock = input.clock ?? defaultClock<Timer>();
  const intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;
  let timer: Timer | undefined;
  let stopped = true;

  const schedule = () => {
    timer = clock.setTimeout(tick, intervalMs);
  };
  const tick = () => {
    void runPiAutoManageCycle(input).catch((error) => {
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
    if (activeProjectCycles.has(project.project_id)) {
      result.skipped += 1;
      continue;
    }
    await runManagedProjectCycle(input.runProjectCycle, project);
    result.started += 1;
  }
  return result;
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
