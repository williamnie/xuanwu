import type { RunnerDatabase } from "../db/database.ts";
import { isPiHeartbeatPaused } from "../db/repositories/pi.ts";
import { createNativeAutomationExecutor } from "./automationRuntime.ts";
import type { PiAutoManageCycleInput, PiAutoManageCycleResult, EnabledProjectRow, PiAutoManageProjectCycle } from "./piAutoManageScheduler.model.ts";

export const activeProjectCycles = new Set<string>();

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

export function withNativeAutomationExecutor<T extends PiAutoManageCycleInput>(input: T): T {
  if (input.runAutomationCore) return input;
  return { ...input, runAutomationCore: createNativeAutomationExecutor(input) };
}

export function shouldRunSupervisor(now: number, lastAt: number, intervalMs: number): boolean {
  return lastAt === 0 || now - lastAt >= intervalMs;
}

export function isProjectHeartbeatPaused(db: RunnerDatabase, projectID: string): boolean {
  return isPiHeartbeatPaused(db, { scopeId: projectID, scopeType: "project" });
}

export function listAutoManagedProjects(db: RunnerDatabase): EnabledProjectRow[] {
  return db.sqlite.query<EnabledProjectRow, []>(`
    select s.project_id
    from project_pi_settings s
    join projects p on p.id = s.project_id
    join pi_agents a on a.id = 'runner-default' and a.enabled = 1
    order by p.sort_order asc, p.created_at asc, p.id asc
  `).all();
}

export async function runManagedProjectCycle(runProjectCycle: PiAutoManageProjectCycle, project: EnabledProjectRow): Promise<void> {
  activeProjectCycles.add(project.project_id);
  try {
    await runProjectCycle({ projectId: project.project_id });
  } finally {
    activeProjectCycles.delete(project.project_id);
  }
}
