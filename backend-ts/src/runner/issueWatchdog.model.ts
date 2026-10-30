import type { RunnerDatabase } from "../db/database.ts";
import type { EventBus } from "../events/bus.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";

export type IssueWatchdogSummary = {
  attentioned: number;
  candidates: number;
  escalated: number;
  kicked: number;
  recentlyKicked: number;
  scanned: number;
  skippedBusy: number;
  waiting: number;
};

export type IssueWatchdogInput = {
  bus?: Pick<EventBus, "publish">;
  database: RunnerDatabase;
  escalateAfterMs?: number;
  limit?: number;
  maxKickAttempts?: number;
  now?: Date | string;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  staleAfterMs?: number;
};

export type StaleTodoRow = {
  created_at: string;
  id: number;
  project_id: string;
  project_name: string;
  provider: string;
  status: string;
  title: string;
  updated_at: string;
};

export type WatchdogState = {
  attention: boolean;
  authority: string;
  nextCheckAt: string;
  reason: string;
  rootBlocker: unknown;
  stateKey: string;
};

export type StoredWatchdogState = { stateKey: string };

export const DEFAULT_ESCALATE_AFTER_MS = 2 * 60 * 1000;

export const DEFAULT_LIMIT = 20;

export const DEFAULT_MAX_KICK_ATTEMPTS = 3;

export const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000;

export const WATCHDOG_ALERT_PREFIX = "issue_watchdog_";

export const RUNTIME_MISMATCH_ALERT_PREFIX = "issue_runtime_mismatch_";
