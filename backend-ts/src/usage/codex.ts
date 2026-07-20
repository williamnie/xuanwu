import { addDimensionUsage, finishDimensions, newDimensionState } from "./dimensions.ts";
import { addUsage, dayKey, isoWeekKey, monthKey, normalizeRateLimits, timestamp, timestampMs, tokenUsage, zeroUsage } from "./helpers.ts";
import { readUsageSnapshot } from "./reader.ts";
import type { RateLimits, TokenEvent, TokenUsage, UsageBucket, UsageOptions, UsageRecord, UsageReport } from "./types.ts";

const MAX_DAILY_PERIODS = 31;
const MAX_WEEKLY_PERIODS = 12;
const MAX_MONTHLY_PERIODS = 12;

type UsageState = ReturnType<typeof newUsageState>;

export async function readCodexUsage(input: {
  backgroundRefresh?: boolean;
  indexPath?: string;
  now?: Date;
  options?: UsageOptions;
  root: string;
}): Promise<UsageReport> {
  const root = input.root.trim();
  if (root === "") throw new Error("codex sessions dir 未配置");
  const options = input.options ?? {};
  const snapshot = await readUsageSnapshot(root, options.limit ?? 0, {
    backgroundRefresh: input.backgroundRefresh,
    indexPath: input.indexPath
  });
  return aggregateUsage(root, snapshot, input.now ?? new Date(), options);
}

function aggregateUsage(
  root: string,
  snapshot: Awaited<ReturnType<typeof readUsageSnapshot>>,
  now: Date,
  options: UsageOptions
): UsageReport {
  const state = newUsageState(root, now, options);
  state.cache = snapshot.cache;
  state.freshness = snapshot.freshness;
  const limit = options.limit ?? 0;
  if (limit > 0) {
    for (const record of snapshot.recent.slice(-limit)) addRecord(state, record);
  } else {
    for (const bucket of snapshot.buckets) addBucket(state, bucket);
    if (snapshot.latestUsage) captureLatestUsage(state, snapshot.latestUsage.event);
    if (snapshot.latestLimits) captureLatestLimits(state, snapshot.latestLimits.event);
  }
  return finishUsageState(state);
}

function addBucket(state: UsageState, bucket: UsageBucket): void {
  state.events_scanned += bucket.events;
  addUsageToSummary(state, new Date(bucket.timestamp), bucket.usage);
  addDimensionUsage(state.dimensions, bucket.meta, bucket.usage);
}

function addRecord(state: UsageState, record: UsageRecord): void {
  const event = record.event;
  if (event.payload?.info) {
    const usage = tokenUsage(event.payload.info.last_token_usage);
    state.events_scanned += 1;
    addUsageToSummary(state, timestamp(event), usage);
    captureLatestUsage(state, event);
    addDimensionUsage(state.dimensions, record.meta, usage);
  }
  if (event.payload?.rate_limits) captureLatestLimits(state, event);
}

function newUsageState(root: string, now: Date, options: UsageOptions) {
  return {
    daily: new Map<string, TokenUsage>(),
    cache: {} as Record<string, number>,
    dimensions: newDimensionState(options),
    events_scanned: 0,
    freshness: {} as Record<string, unknown>,
    generated_at: now.toISOString(),
    latest_limit_ms: -1,
    latest_usage: undefined as Record<string, unknown> | undefined,
    latest_usage_ms: -1,
    monthly: new Map<string, TokenUsage>(),
    now,
    rate_limits: null as RateLimits | null,
    root,
    summary: {
      all_time: zeroUsage(),
      this_month: zeroUsage(),
      this_week: zeroUsage(),
      today: zeroUsage()
    },
    weekly: new Map<string, TokenUsage>()
  };
}

function addUsageToSummary(state: UsageState, ts: Date, usage: TokenUsage): void {
  if (usage.total_tokens === 0) return;
  addUsage(state.summary.all_time, usage);
  addUsage(mapUsage(state.daily, dayKey(ts)), usage);
  addUsage(mapUsage(state.weekly, isoWeekKey(ts)), usage);
  addUsage(mapUsage(state.monthly, monthKey(ts)), usage);
  if (dayKey(ts) === dayKey(state.now)) addUsage(state.summary.today, usage);
  if (isoWeekKey(ts) === isoWeekKey(state.now)) addUsage(state.summary.this_week, usage);
  if (monthKey(ts) === monthKey(state.now)) addUsage(state.summary.this_month, usage);
}

function captureLatestUsage(state: UsageState, event: TokenEvent): void {
  const at = timestampMs(event);
  if (at <= state.latest_usage_ms) return;
  const info = event.payload?.info;
  state.latest_usage_ms = at;
  state.latest_usage = {
    captured_at: timestamp(event).toISOString(),
    last_token_usage: tokenUsage(info?.last_token_usage),
    model_context_window: info?.model_context_window ?? 0,
    total_token_usage: tokenUsage(info?.total_token_usage)
  };
}

function captureLatestLimits(state: UsageState, event: TokenEvent): void {
  const at = timestampMs(event);
  if (at <= state.latest_limit_ms) return;
  state.latest_limit_ms = at;
  state.rate_limits = normalizeRateLimits(event.payload?.rate_limits ?? {});
  state.rate_limits.captured_at = timestamp(event).toISOString();
}

function finishUsageState(state: UsageState): UsageReport {
  return {
    source: state.root,
    generated_at: state.generated_at,
    events_scanned: state.events_scanned,
    cache: state.cache,
    freshness: state.freshness,
    ...(state.latest_usage ? { latest_usage: state.latest_usage } : {}),
    rate_limits: state.rate_limits,
    summary: state.summary,
    daily: periodsFromMap(state.daily, MAX_DAILY_PERIODS),
    weekly: periodsFromMap(state.weekly, MAX_WEEKLY_PERIODS),
    monthly: periodsFromMap(state.monthly, MAX_MONTHLY_PERIODS),
    project_usage: finishDimensions(state.dimensions, state.summary.all_time.total_tokens)
  };
}

function mapUsage(values: Map<string, TokenUsage>, key: string): TokenUsage {
  const current = values.get(key) ?? zeroUsage();
  values.set(key, current);
  return current;
}

function periodsFromMap(values: Map<string, TokenUsage>, max: number): Array<Record<string, unknown>> {
  return [...values.keys()].sort().slice(-max).map((key) => ({ key, label: key, usage: values.get(key) }));
}
