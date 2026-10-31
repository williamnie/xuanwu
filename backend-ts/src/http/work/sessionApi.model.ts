import type { RunnerDatabase } from "../../db/database.ts";
import type { EventBus } from "../../events/bus.ts";
import { type ExecutorProvider, type ExecutorProviderId } from "../../providers/types.ts";

export type SessionApiContext = {
  bus?: EventBus;
  database: RunnerDatabase;
  interruptTimeoutMs?: number;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};

export type QualifiedSessionRef = { key: string; provider: string; sessionId: string };
