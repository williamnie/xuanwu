import type { RunnerDatabase } from "../db/database.ts";
import type { EventBus } from "../events/bus.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { type IssueSupervisorRecoveryContext } from "../pi/supervisor/issueSupervisorContext.ts";
import { type PiSupervisorDecisionRuntimeResult } from "../pi/supervisor/issueSupervisorDecision.ts";

export type PiIssueSupervisorSchedulerInput = {
  bus?: Pick<EventBus, "publish">;
  database: RunnerDatabase;
  limit?: number;
  now?: Date;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  runDecision?: (context: IssueSupervisorRecoveryContext) => Promise<PiSupervisorDecisionRuntimeResult>;
  staleAfterSeconds?: number;
};

export type PiIssueSupervisorSchedulerResult = {
  decisions: number;
  failed: number;
  scanned: number;
  signaled: number;
  skipped: number;
};

export type SupervisorTarget = {
  candidates: IssueSupervisorRecoveryContext["candidates"];
  context: IssueSupervisorRecoveryContext;
  issueID: number;
  projectID: string;
};

export type SupervisorDecisionSelection = PiSupervisorDecisionRuntimeResult & {
  recordDecision?: boolean;
};

export const activeSupervisorIssues = new Set<string>();

export const DEFAULT_LIMIT = 50;

export const DEFAULT_STALE_SECONDS = 5 * 60;

export const MAX_INVALID_DECISIONS_PER_EVIDENCE = 2;
