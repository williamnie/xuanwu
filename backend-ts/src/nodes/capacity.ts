import type { RunnerDatabase } from "../db/database.ts";
import { countActiveExecutorWorkAt } from "../db/repositories/issueQueue.ts";
import { getRemoteNode } from "../db/repositories/nodes.ts";
import { projectLocation } from "./projectLocation.ts";

export const DEFAULT_NODE_MAX_PARALLEL = 1;

/** 项目的执行位置：空串为中心本机，否则为节点 ID。 */
export function projectExecutionLocation(db: RunnerDatabase, projectID: string): string {
  const cwd = db.sqlite.query<{ cwd: string }, [string]>("select cwd from projects where id=?").get(projectID.trim())?.cwd ?? "";
  return projectLocation(cwd).nodeId;
}

/** 执行位置的并发上限：中心本机沿用 maxParallelProjects，节点使用其声明的 max_parallel。 */
export function executionLocationMaximum(db: RunnerDatabase, nodeID: string, localMaximum: number): number {
  if (nodeID === "") return localMaximum;
  return getRemoteNode(db, nodeID)?.info.max_parallel ?? DEFAULT_NODE_MAX_PARALLEL;
}

/** 该位置是否还有名额：在途运行与本进程已启动的 worker 都不超过上限。 */
export function executionLocationHasCapacity(db: RunnerDatabase, nodeID: string, workers: number, localMaximum: number): boolean {
  const maximum = executionLocationMaximum(db, nodeID, localMaximum);
  return countActiveExecutorWorkAt(db, nodeID) < maximum && workers < maximum;
}
