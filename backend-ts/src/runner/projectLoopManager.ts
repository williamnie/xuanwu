import {
  projectLoopDecision,
  recordProjectLoopDecision,
  runProjectLoopOnce,
  type ProjectLoopInput
} from "./projectLoop.ts";
import {
  countActiveExecutorWork,
  hasActiveExecutorWorkForProject,
  projectExecutionLockKey
} from "../db/repositories/issueQueue.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { EventBus } from "../events/bus.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";

export type ProjectLoopRuntime = {
  bus?: Pick<EventBus, "publish">;
  database: RunnerDatabase;
  onError?: (error: unknown, projectID: string) => void;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};
export type ProjectLoopStartOptions = { forceOnce?: boolean };

type ProjectLoopState = {
  activeLockKeys: Set<string>;
  activeLoops: Set<string>;
  forcedProjects: Set<string>;
  waitingProjects: string[];
  workerCount: number;
};

const statesByDatabase = new WeakMap<RunnerDatabase, ProjectLoopState>();
const activeLoopCounts = new Map<string, number>();
let maxParallelProjects = 1;

type RunnableProject = { id: string; lockKey: string };

export function startProjectLoop(
  runtime: ProjectLoopRuntime,
  projectID: string,
  options: ProjectLoopStartOptions = {}
): void {
  const id = projectID.trim();
  if (id === "") return;
  const state = stateFor(runtime.database);
  if (options.forceOnce === true) state.forcedProjects.add(id);
  if (state.activeLoops.has(id)) {
    startQueuedWorkers(runtime);
    return;
  }
  state.activeLoops.add(id);
  incrementActiveLoop(id);
  enqueueProject(state, id);
  startQueuedWorkers(runtime);
}

export function isProjectLoopActive(projectID: string, database?: RunnerDatabase): boolean {
  const id = projectID.trim();
  if (database) return stateFor(database).activeLoops.has(id);
  return (activeLoopCounts.get(id) ?? 0) > 0;
}

export function runningProjectLoopCount(): number {
  return [...activeLoopCounts.values()].reduce((count, value) => count + value, 0);
}

export function setProjectLoopMaxParallelProjects(value: number): void {
  maxParallelProjects = normalizedMaxParallelProjects(value);
}

export function projectLoopMaxParallelProjects(): number {
  return maxParallelProjects;
}

export function kickAutoRunProjects(runtime: ProjectLoopRuntime): void {
  requeueProjectsWithTodo(runtime);
  startQueuedWorkers(runtime);
}

async function runWorker(runtime: ProjectLoopRuntime, project: RunnableProject): Promise<void> {
  const state = stateFor(runtime.database);
  try {
    await runProject(runtime, project.id);
  } catch (error) {
    runtime.onError?.(error, project.id);
  } finally {
    state.activeLockKeys.delete(project.lockKey);
    state.workerCount = Math.max(0, state.workerCount - 1);
    startQueuedWorkers(runtime, project.id);
  }
}

async function runProject(runtime: ProjectLoopRuntime, projectID: string): Promise<void> {
  const state = stateFor(runtime.database);
  let shouldRequeue = true;
  try {
    shouldRequeue = await runProjectLoop(runtime, projectID);
  } catch (error) {
    shouldRequeue = false;
    runtime.onError?.(error, projectID);
  } finally {
    state.forcedProjects.delete(projectID);
    deleteActiveLoop(state, projectID);
    if (shouldRequeue) requeueProjectsWithTodo(runtime);
  }
}

async function runProjectLoop(runtime: ProjectLoopRuntime, projectID: string): Promise<boolean> {
  const state = stateFor(runtime.database);
  while (shouldContinue(runtime, projectID, state.forcedProjects.has(projectID))) {
    const result = await runProjectLoopOnce(loopInput(runtime, projectID));
    if (!result.claimed) break;
  }
  return true;
}

function shouldContinue(runtime: ProjectLoopRuntime, projectID: string, forceOnce: boolean): boolean {
  if (hasActiveExecutorWorkForProject(runtime.database, projectID)) return false;
  return projectLoopDecision(loopInput(runtime, projectID), forceOnce).allowed;
}

function loopInput(runtime: ProjectLoopRuntime, projectID: string): ProjectLoopInput {
  return {
    bus: runtime.bus,
    database: runtime.database,
    onProjectSlotReleased: () => kickAutoRunProjects(runtime),
    projectId: projectID,
    providers: runtime.providers ?? {}
  };
}

function enqueueProject(state: ProjectLoopState, projectID: string): void {
  if (state.waitingProjects.includes(projectID)) return;
  state.waitingProjects.push(projectID);
}

function requeueProjectsWithTodo(runtime: ProjectLoopRuntime): void {
  const state = stateFor(runtime.database);
  const projects = runtime.database.sqlite.query<{ id: string }, []>(
    "select id from projects where auto_run=1 order by sort_order asc, created_at asc, id asc"
  ).all();
  for (const project of projects) {
    if (state.activeLoops.has(project.id) || hasActiveExecutorWorkForProject(runtime.database, project.id) ||
      !projectLoopDecision(loopInput(runtime, project.id), false).allowed) continue;
    state.activeLoops.add(project.id);
    incrementActiveLoop(project.id);
    enqueueProject(state, project.id);
  }
}

function startQueuedWorkers(runtime: ProjectLoopRuntime, errorProjectID = "project-loop"): void {
  try {
    drainQueuedWorkers(runtime);
  } catch (error) {
    runtime.onError?.(error, errorProjectID);
  }
}

function drainQueuedWorkers(runtime: ProjectLoopRuntime): void {
  const state = stateFor(runtime.database);
  while (canStartWorker(runtime.database, state)) {
    const project = nextRunnableProject(runtime, state);
    if (!project) return;
    state.activeLockKeys.add(project.lockKey);
    state.workerCount += 1;
    void runWorker(runtime, project);
  }
}

function canStartWorker(db: RunnerDatabase, state: ProjectLoopState): boolean {
  return state.workerCount < maxParallelProjects && countActiveExecutorWork(db) < maxParallelProjects;
}

function nextRunnableProject(runtime: ProjectLoopRuntime, state: ProjectLoopState): RunnableProject | null {
  const attempts = state.waitingProjects.length;
  for (let index = 0; index < attempts; index += 1) {
    const id = state.waitingProjects.shift();
    if (!id) continue;
    const lockKey = projectExecutionLockKey(runtime.database, id);
    if (state.activeLockKeys.has(lockKey)) {
      state.waitingProjects.push(id);
      continue;
    }
    const gate = projectLoopDecision(loopInput(runtime, id), state.forcedProjects.has(id));
    if (hasActiveExecutorWorkForProject(runtime.database, id) || !gate.allowed) {
      if (!gate.allowed) recordProjectLoopDecision(runtime.database, gate);
      state.forcedProjects.delete(id);
      deleteActiveLoop(state, id);
      continue;
    }
    return { id, lockKey };
  }
  return null;
}

function normalizedMaxParallelProjects(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function stateFor(database: RunnerDatabase): ProjectLoopState {
  const existing = statesByDatabase.get(database);
  if (existing) return existing;
  const state: ProjectLoopState = {
    activeLockKeys: new Set(),
    activeLoops: new Set(),
    forcedProjects: new Set(),
    waitingProjects: [],
    workerCount: 0
  };
  statesByDatabase.set(database, state);
  return state;
}

function incrementActiveLoop(projectID: string): void {
  activeLoopCounts.set(projectID, (activeLoopCounts.get(projectID) ?? 0) + 1);
}

function deleteActiveLoop(state: ProjectLoopState, projectID: string): void {
  if (!state.activeLoops.delete(projectID)) return;
  const next = (activeLoopCounts.get(projectID) ?? 1) - 1;
  if (next <= 0) activeLoopCounts.delete(projectID);
  else activeLoopCounts.set(projectID, next);
}
