import { addDimensionUsage, finishDimensions, newDimensionState } from "./dimensions.ts";
import { addUsage, dayKey, isoWeekKey, monthKey, normalizeRateLimits, timestamp, timestampMs, tokenUsage, zeroUsage } from "./helpers.ts";
import { readUsageRecords } from "./reader.ts";
import type { RateLimits, TokenEvent, TokenUsage, UsageOptions, UsageRecord, UsageReport } from "./types.ts";

const MAX_DAILY_PERIODS = 31;
const MAX_WEEKLY_PERIODS = 12;
const MAX_MONTHLY_PERIODS = 12;

type UsageState = ReturnType<typeof newUsageState>;

export async function readCodexUsage(input: {
  now?: Date;
  options?: UsageOptions;
  root: string;
}): Promise<UsageReport> {
  const root = input.root.trim();
  if (root === "") throw new Error("codex sessions dir 未配置");
  return aggregateUsage(root, await readUsageRecords(root), input.now ?? new Date(), input.options ?? {});
}

function aggregateUsage(root: string, records: UsageRecord[], now: Date, options: UsageOptions): UsageReport {
  const state = newUsageState(root, now, options);
  for (const record of filteredRecords(records, options.limit ?? 0)) addRecord(state, record);
  return finishUsageState(state);
}

function addRecord(state: UsageState, record: UsageRecord): void {
  const event = record.event;
  if (event.payload?.info) {
    const usage = tokenUsage(event.payload.info.last_token_usage);
    state.events_scanned += 1;
    addUsageToSummary(state, timestamp(event), usage);
    captureLatestUsage(state, event);
    addDimensionUsage(state.dimensions, record, usage);
  }
  if (event.payload?.rate_limits) captureLatestLimits(state, event);
}

function newUsageState(root: string, now: Date, options: UsageOptions) {
  return {
    daily: new Map<string, TokenUsage>(),
    dimensions: newDimensionState(options),
    events_scanned: 0,
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
    ...(state.latest_usage ? { latest_usage: state.latest_usage } : {}),
    rate_limits: state.rate_limits,
    summary: state.summary,
    daily: periodsFromMap(state.daily, MAX_DAILY_PERIODS),
    weekly: periodsFromMap(state.weekly, MAX_WEEKLY_PERIODS),
    monthly: periodsFromMap(state.monthly, MAX_MONTHLY_PERIODS),
    project_usage: finishDimensions(state.dimensions, state.summary.all_time.total_tokens)
  };
}

function filteredRecords(records: UsageRecord[], limit: number): UsageRecord[] {
  const sorted = records.slice().sort((a, b) => timestampMs(a.event) - timestampMs(b.event));
  return limit > 0 && sorted.length > limit ? sorted.slice(sorted.length - limit) : sorted;
}

function mapUsage(values: Map<string, TokenUsage>, key: string): TokenUsage {
  const current = values.get(key) ?? zeroUsage();
  values.set(key, current);
  return current;
}

function periodsFromMap(values: Map<string, TokenUsage>, max: number): Array<Record<string, unknown>> {
  return [...values.keys()].sort().slice(-max).map((key) => ({ key, label: key, usage: values.get(key) }));
}
