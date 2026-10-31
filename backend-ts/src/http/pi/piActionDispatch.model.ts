import type { RunnerDatabase } from "../../db/database.ts";
import type { RunnerConfig } from "../../config/env.ts";
import { type ProjectLoopRuntime, type ProjectLoopStartOptions } from "../../runner/projectLoopManager.ts";
import type { EventBus } from "../../events/bus.ts";
import { type ExecutorProvider, type ExecutorProviderId } from "../../providers/types.ts";
import { type SystemRestartAuditEvent } from "../system/systemRestartApi.ts";

export type ProjectLoopStarter = (
  runtime: ProjectLoopRuntime,
  projectID: string,
  options?: ProjectLoopStartOptions
) => void;

export type PiActionDispatchContext = {
  auditSystemRestart?: (event: SystemRestartAuditEvent) => void;
  bus?: Pick<EventBus, "publish">;
  config?: RunnerConfig;
  database: RunnerDatabase;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  restartDelayMs?: number;
  restartProcess?: () => void;
  startProjectLoop?: ProjectLoopStarter;
  supervisorManaged?: boolean;
};
