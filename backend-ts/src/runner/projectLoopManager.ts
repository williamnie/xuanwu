import { runProjectLoopOnce, type ProjectLoopInput } from "./projectLoop.ts";
import { getProject } from "../db/repositories/projects.ts";
import {
  countActiveExecutorWork,
  hasActiveExecutorWorkForProject,
  hasTodoIssue,
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

const activeLoops = new Set<string>();
const activeLockKeys = new Set<string>();
const forcedProjects = new Set<string>();
const waitingProjects: string[] = [];
let workerCount = 0;
let maxParallelProjects = 1;

type RunnableProject = { id: string; lockKey: string };

export function startProjectLoop(
  runtime: ProjectLoopRuntime,
  projectID: string,
  options: ProjectLoopStartOptions = {}
): void {
  const id = projectID.trim();
  if (id === "") return;
  if (options.forceOnce === true) forcedProjects.add(id);
  if (activeLoops.has(id)) {
    startQueuedWorkers(runtime);
    return;
  }
  activeLoops.add(id);
  enqueueProject(id);
  startQueuedWorkers(runtime);
}

export function isProjectLoopActive(projectID: string): boolean {
  return activeLoops.has(projectID.trim());
}

export function runningProjectLoopCount(): number {
  return activeLoops.size;
}

export function setProjectLoopMaxParallelProjects(value: number): void {
  maxParallelProjects = normalizedMaxParallelProjects(value);
}

export function projectLoopMaxParallelProjects(): number {
  return maxParallelProjects;
}

export function kickAutoRunProjects(runtime: ProjectLoopRuntime): void {
  requeueProjectsWithTodo(runtime.database);
  startQueuedWorkers(runtime);
}

async function runWorker(runtime: ProjectLoopRuntime, project: RunnableProject): Promise<void> {
  try {
    await runProject(runtime, project.id);
  } catch (error) {
    runtime.onError?.(error, project.id);
  } finally {
    activeLockKeys.delete(project.lockKey);
    workerCount = Math.max(0, workerCount - 1);
    startQueuedWorkers(runtime, project.id);
  }
}

async function runProject(runtime: ProjectLoopRuntime, projectID: string): Promise<void> {
  let shouldRequeue = true;
  try {
    shouldRequeue = await runProjectLoop(runtime, projectID);
  } catch (error) {
    shouldRequeue = false;
    runtime.onError?.(error, projectID);
  } finally {
    forcedProjects.delete(projectID);
    activeLoops.delete(projectID);
    if (shouldRequeue) requeueProjectsWithTodo(runtime.database);
  }
}

function isAutoRunEnabled(db: RunnerDatabase, projectID: string): boolean {
  return (getProject(db, projectID)?.auto_run ?? 0) === 1;
}

async function runProjectLoop(runtime: ProjectLoopRuntime, projectID: string): Promise<boolean> {
  while (shouldContinue(runtime.database, projectID, forcedProjects.has(projectID))) {
    const result = await runProjectLoopOnce(loopInput(runtime, projectID));
    if (!result.claimed) break;
    if (result.run.runId === "failed") return false;
  }
  return true;
}

function shouldContinue(db: RunnerDatabase, projectID: string, forceOnce: boolean): boolean {
  return (forceOnce || isAutoRunEnabled(db, projectID)) && !hasActiveExecutorWorkForProject(db, projectID);
}

function loopInput(runtime: ProjectLoopRuntime, projectID: string): ProjectLoopInput {
  return { bus: runtime.bus, database: runtime.database, projectId: projectID, providers: runtime.providers ?? {} };
}

function enqueueProject(projectID: string): void {
  if (waitingProjects.includes(projectID)) return;
  waitingProjects.push(projectID);
}

function requeueProjectsWithTodo(db: RunnerDatabase): void {
  const projects = db.sqlite.query<{ id: string }, []>(
    "select id from projects where auto_run=1 order by sort_order asc, created_at asc, id asc"
  ).all();
  for (const project of projects) {
    if (activeLoops.has(project.id) || hasActiveExecutorWorkForProject(db, project.id) || !hasTodoIssue(db, project.id)) continue;
    activeLoops.add(project.id);
    enqueueProject(project.id);
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
  while (canStartWorker(runtime.database)) {
    const project = nextRunnableProject(runtime);
    if (!project) return;
    activeLockKeys.add(project.lockKey);
    workerCount += 1;
    void runWorker(runtime, project);
  }
}

function canStartWorker(db: RunnerDatabase): boolean {
  return workerCount < maxParallelProjects && countActiveExecutorWork(db) < maxParallelProjects;
}

function nextRunnableProject(runtime: ProjectLoopRuntime): RunnableProject | null {
  const attempts = waitingProjects.length;
  for (let index = 0; index < attempts; index += 1) {
    const id = waitingProjects.shift();
    if (!id) continue;
    const lockKey = projectExecutionLockKey(runtime.database, id);
    if (activeLockKeys.has(lockKey)) {
      waitingProjects.push(id);
      continue;
    }
    if (!shouldContinue(runtime.database, id, forcedProjects.has(id))) {
      forcedProjects.delete(id);
      activeLoops.delete(id);
      continue;
    }
    return { id, lockKey };
  }
  return null;
}

function normalizedMaxParallelProjects(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : 1;
}
