import type { RunnerDatabase } from "../../db/database.ts";
import { type ExecutorProvider, type ExecutorProviderId } from "../../providers/types.ts";
import { type ProjectLoopRuntime, type ProjectLoopStartOptions } from "../../runner/projectLoopManager.ts";
import type { EventBus } from "../../events/bus.ts";

export type ProjectLoopStarter = (
  runtime: ProjectLoopRuntime,
  projectID: string,
  options?: ProjectLoopStartOptions
) => void;

export type SupervisorDispatchContext = {
  bus?: Pick<EventBus, "publish">;
  database: RunnerDatabase;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  startProjectLoop?: ProjectLoopStarter;
};
