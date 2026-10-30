import type { RunnerDatabase } from "../../db/database.ts";
import type { EventBus } from "../../events/bus.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../../providers/types.ts";
import type { RunnerConfig } from "../../config/env.ts";
import { type ProjectLoopStarter } from "./piActionDispatch.ts";
import type { SystemRestartAuditEvent } from "../system/systemRestartApi.ts";
import type { actor } from "./piActionDecision.assertFreshPiAction.ts";

export type PiActionDecisionContext = {
  auditSystemRestart?: (event: SystemRestartAuditEvent) => void;
  bus?: EventBus;
  config?: RunnerConfig;
  database: RunnerDatabase;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  restartDelayMs?: number;
  restartProcess?: () => void;
  startProjectLoop?: ProjectLoopStarter;
  supervisorManaged?: boolean;
};

export type PiActionResolveDecision = "approve" | "approve_always" | "reject" | "request_changes" | "snooze";

export type PiActionResolveInput = {
  actionID: string;
  actor?: string;
  comment?: string;
  decision: PiActionResolveDecision;
  reason?: string;
  snoozedUntil?: string;
};
