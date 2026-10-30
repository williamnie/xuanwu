import { type Issue } from "../db/repositories/issues.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { EventBus } from "../events/bus.ts";
import { type ExecutorProvider, type ExecutorProviderId, type ProviderRunResult } from "../providers/types.ts";

export type ProjectLoopInput = {
  bus?: Pick<EventBus, "publish">;
  database: RunnerDatabase;
  now?: Date | string;
  onProjectSlotReleased?: (projectID: string) => void;
  projectId: string;
  providers: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};

export type ProjectLoopResult =
  | { claimed: false }
  | { claimed: true; issue: Issue; run: ProviderRunResult };

export type ProjectLoopDecision = {
  allowed: boolean;
  authority: string;
  issue: Issue | null;
  provider: string;
  reason: "dependency_blocker" | "no_work" | "project_hold" | "provider_runtime" | "ready" | "user_pause";
  scope: string;
};
