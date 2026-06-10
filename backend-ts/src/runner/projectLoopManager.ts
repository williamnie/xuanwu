import { runProjectLoopOnce, type ProjectLoopInput } from "./projectLoop.ts";
import { getProject } from "../db/repositories/projects.ts";
import { hasActiveExecutorWork, hasTodoIssue } from "../db/repositories/issueQueue.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { EventBus } from "../events/bus.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";

export type ProjectLoopRuntime = {
  bus?: Pick<EventBus, "publish">;
  database: RunnerDatabase;
  onError?: (error: unknown, projectID: string) => void;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};

const activeLoops = new Set<string>();
const waitingProjects: string[] = [];
let workerActive = false;

export function startProjectLoop(runtime: ProjectLoopRuntime, projectID: string): void {
  const id = projectID.trim();
  if (id === "" || activeLoops.has(id)) return;
  activeLoops.add(id);
  enqueueProject(id);
  if (!workerActive) {
    workerActive = true;
    void runWorker(runtime);
  }
}

export function isProjectLoopActive(projectID: string): boolean {
  return activeLoops.has(projectID.trim());
}

export function runningProjectLoopCount(): number {
  return activeLoops.size;
}

async function runWorker(runtime: ProjectLoopRuntime): Promise<void> {
  try {
    await drainQueue(runtime);
  } catch (error) {
    runtime.onError?.(error, "");
  } finally {
    workerActive = false;
    if (waitingProjects.length > 0) startQueuedWorker(runtime);
  }
}

async function drainQueue(runtime: ProjectLoopRuntime): Promise<void> {
  let id: string | undefined;
  while ((id = waitingProjects.shift())) {
    await runProject(runtime, id);
  }
}

async function runProject(runtime: ProjectLoopRuntime, projectID: string): Promise<void> {
  try {
    await runProjectLoop(runtime, projectID);
  } catch (error) {
    runtime.onError?.(error, projectID);
  } finally {
    activeLoops.delete(projectID);
    requeueProjectsWithTodo(runtime.database);
  }
}

function isAutoRunEnabled(db: RunnerDatabase, projectID: string): boolean {
  return (getProject(db, projectID)?.auto_run ?? 0) === 1;
}

async function runProjectLoop(runtime: ProjectLoopRuntime, projectID: string): Promise<void> {
  while (shouldContinue(runtime.database, projectID)) {
    const result = await runProjectLoopOnce(loopInput(runtime, projectID));
    if (!result.claimed) break;
  }
}

function shouldContinue(db: RunnerDatabase, projectID: string): boolean {
  return isAutoRunEnabled(db, projectID) && !hasActiveExecutorWork(db);
}

function loopInput(runtime: ProjectLoopRuntime, projectID: string): ProjectLoopInput {
  return { bus: runtime.bus, database: runtime.database, projectId: projectID, providers: runtime.providers ?? {} };
}

function enqueueProject(projectID: string): void {
  if (waitingProjects.includes(projectID)) return;
  waitingProjects.push(projectID);
}

function requeueProjectsWithTodo(db: RunnerDatabase): void {
  if (hasActiveExecutorWork(db)) return;
  const projects = db.sqlite.query<{ id: string }, []>(
    "select id from projects where auto_run=1 order by sort_order asc, created_at asc, id asc"
  ).all();
  for (const project of projects) {
    if (activeLoops.has(project.id) || !hasTodoIssue(db, project.id)) continue;
    activeLoops.add(project.id);
    enqueueProject(project.id);
  }
}

function startQueuedWorker(runtime: ProjectLoopRuntime): void {
  if (workerActive) return;
  workerActive = true;
  void runWorker(runtime);
}
