import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  queryUsageIndex,
  refreshUsageIndexInWorker,
  usageIndexIsValid,
  type UsageIndexMetrics
} from "./usageIndex.ts";
import type { UsageBucket, UsageRecord } from "./types.ts";

export type UsageSnapshot = {
  buckets: UsageBucket[];
  cache: UsageIndexMetrics;
  freshness: {
    corrupt_lines: number;
    indexed_at: string;
    index_path: string;
    index_version: number;
    last_error?: string;
    state: "fresh" | "refreshing" | "stale";
  };
  latestLimits?: UsageRecord;
  latestUsage?: UsageRecord;
  recent: UsageRecord[];
};

export type UsageReaderOptions = {
  backgroundRefresh?: boolean;
  indexPath?: string;
};

type ReaderState = {
  cache: Map<number, UsageSnapshot>;
  lastError?: string;
  refresh?: Promise<void>;
  root: string;
  validated: boolean;
};

const states = new Map<string, ReaderState>();

export async function readUsageSnapshot(
  root: string,
  recentLimit = 0,
  options: UsageReaderOptions = {}
): Promise<UsageSnapshot> {
  const indexPath = options.indexPath ?? defaultUsageIndexPath(root);
  const state = stateFor(indexPath, root);
  const hasSnapshot = await ensureValidSnapshot(root, indexPath, state);

  if (!hasSnapshot || !options.backgroundRefresh) {
    await runRefresh(root, indexPath, state);
  } else {
    startBackgroundRefresh(root, indexPath, state);
  }

  try {
    const cached = recentLimit === 0 ? state.cache.get(recentLimit) : undefined;
    if (cached) return withCurrentFreshness(cached, state);
    const snapshot = queryUsageIndex(indexPath, root, recentLimit, {
      lastError: state.lastError,
      refreshing: Boolean(state.refresh)
    });
    if (recentLimit === 0) state.cache.set(recentLimit, snapshot);
    return snapshot;
  } catch {
    state.validated = false;
    state.cache.clear();
    await runRefresh(root, indexPath, state, true);
    return queryUsageIndex(indexPath, root, recentLimit, {
      lastError: state.lastError,
      refreshing: Boolean(state.refresh)
    });
  }
}

export function defaultUsageIndexPath(root: string): string {
  return join(root, ".codex-usage-index-v1.sqlite");
}

export async function rebuildUsageIndex(root: string, indexPath = defaultUsageIndexPath(root)): Promise<UsageIndexMetrics> {
  const state = stateFor(indexPath, root);
  await runRefresh(root, indexPath, state, true);
  return queryUsageIndex(indexPath, root, 0, { refreshing: false }).cache;
}

export function resetUsageReaderState(): void {
  states.clear();
}

async function ensureValidSnapshot(root: string, indexPath: string, state: ReaderState): Promise<boolean> {
  if (state.validated) return true;
  if (!existsSync(indexPath)) return false;
  const valid = usageIndexIsValid(indexPath, root);
  state.validated = valid;
  return valid;
}

async function runRefresh(root: string, indexPath: string, state: ReaderState, forceRebuild = false): Promise<void> {
  if (state.refresh) return await state.refresh;
  state.refresh = refreshUsageIndexInWorker(root, indexPath, { forceRebuild })
    .then(() => {
      state.cache.clear();
      state.lastError = undefined;
      state.validated = true;
    })
    .catch((error) => {
      state.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    })
    .finally(() => {
      state.refresh = undefined;
    });
  return await state.refresh;
}

function startBackgroundRefresh(root: string, indexPath: string, state: ReaderState): void {
  if (state.refresh) return;
  void runRefresh(root, indexPath, state).catch(() => undefined);
}

function stateFor(indexPath: string, root: string): ReaderState {
  let state = states.get(indexPath);
  if (!state || state.root !== root) {
    state = { cache: new Map(), root, validated: false };
    states.set(indexPath, state);
  }
  return state;
}

function withCurrentFreshness(snapshot: UsageSnapshot, state: ReaderState): UsageSnapshot {
  return {
    ...snapshot,
    freshness: {
      ...snapshot.freshness,
      ...(state.lastError ? { last_error: state.lastError } : {}),
      state: state.refresh ? "refreshing" : state.lastError ? "stale" : "fresh"
    }
  };
}
