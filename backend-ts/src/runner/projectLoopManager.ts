import { runProjectLoopOnce, type ProjectLoopInput } from "./projectLoop.ts";
import { getProject } from "../db/repositories/projects.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";

export type ProjectLoopRuntime = {
  database: RunnerDatabase;
  onError?: (error: unknown, projectID: string) => void;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};

const activeLoops = new Set<string>();

export function startProjectLoop(runtime: ProjectLoopRuntime, projectID: string): void {
  const id = projectID.trim();
  if (id === "" || activeLoops.has(id)) return;
  activeLoops.add(id);
  void runLoop(runtime, id);
}

export function isProjectLoopActive(projectID: string): boolean {
  return activeLoops.has(projectID.trim());
}

export function runningProjectLoopCount(): number {
  return activeLoops.size;
}

async function runLoop(runtime: ProjectLoopRuntime, projectID: string): Promise<void> {
  try {
    while (isAutoRunEnabled(runtime.database, projectID)) {
      const result = await runProjectLoopOnce(loopInput(runtime, projectID));
      if (!result.claimed) break;
    }
  } catch (error) {
    runtime.onError?.(error, projectID);
  } finally {
    activeLoops.delete(projectID);
  }
}

function isAutoRunEnabled(db: RunnerDatabase, projectID: string): boolean {
  return (getProject(db, projectID)?.auto_run ?? 0) === 1;
}

function loopInput(runtime: ProjectLoopRuntime, projectID: string): ProjectLoopInput {
  return { database: runtime.database, projectId: projectID, providers: runtime.providers ?? {} };
}
