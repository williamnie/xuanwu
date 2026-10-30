import type { RunnerDatabase } from "../db/database.ts";
import type { EventBus } from "../events/bus.ts";
import { type ExecutorProvider, type ExecutorProviderId } from "../providers/types.ts";

export const PI_ACCEPTANCE_DECISION_EVENT = "issue.pi_acceptance_decision.v1";

export const PI_ACCEPTANCE_APPLIED_EVENT = "issue.pi_acceptance_applied.v1";

export const PI_CONTINUATION_PROGRESS_EVENT = "issue.pi_continuation_progress.v1";

export const PI_HUMAN_ACCEPTANCE_HONORED_EVENT = "issue.pi_human_acceptance_honored.v1";

export const MAX_AUTOMATIC_FRESH_SESSION_RETRIES = 2;

export const MAX_CONSECUTIVE_NO_PROGRESS_CONTINUATIONS = 3;

export type PiAcceptanceApplicationRuntime = {
  bus?: Pick<EventBus, "publish">;
  database: RunnerDatabase;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};
