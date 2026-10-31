import { Database } from "bun:sqlite";
import type { RateLimits, TokenInfo, TokenUsage, UsageBucket, UsageRecord } from "./types.ts";
import { USAGE_INDEX_VERSION, DEFAULT_RECENT_RECORD_LIMIT } from "./usageIndex.model.ts";
import type { QueryState, UsageIndexMetrics, BucketRow, EventRow, UsageRow } from "./usageIndex.model.ts";
import { scalarNumber, metadata } from "./usageIndex.metadata.ts";
import { storedMetrics } from "./usageIndex.storage.ts";
import { BUCKET_QUERY } from "./usageIndex.sql.ts";

export function queryUsageIndex(
  indexPath: string,
  root: string,
  recentLimit: number,
  state: QueryState
): {
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
} {
  const db = new Database(indexPath, { readonly: true, strict: true });
  try {
    if (scalarNumber(db, "pragma user_version") !== USAGE_INDEX_VERSION || metadata(db, "source_root") !== root) {
      throw new Error("usage index schema or source mismatch");
    }
    const metrics = storedMetrics(db);
    metrics.index_hits += 1;
    const buckets = db.query<BucketRow, []>(BUCKET_QUERY).all().map(bucketFromRow);
    const latestUsage = latestRecord(db, "info_json is not null", "path asc, byte_offset asc");
    const latestLimits = latestRecord(db, "limits_json is not null", "path asc, byte_offset asc");
    const recent = recentRecords(db, recentLimit > 0 ? recentLimit : DEFAULT_RECENT_RECORD_LIMIT);
    const indexedAt = metadata(db, "indexed_at");
    return {
      buckets,
      cache: metrics,
      freshness: {
        corrupt_lines: metrics.corrupt_lines,
        indexed_at: indexedAt,
        index_path: indexPath,
        index_version: USAGE_INDEX_VERSION,
        ...(state.lastError ? { last_error: state.lastError } : {}),
        state: state.refreshing ? "refreshing" : state.lastError ? "stale" : "fresh"
      },
      latestLimits,
      latestUsage,
      recent
    };
  } finally {
    db.close();
  }
}

export function latestRecord(db: Database, where: string, tieOrder: string): UsageRecord | undefined {
  // 先沿现有索引定位最新时间，再按原有规则处理同一时间的记录，避免全表排序。
  const row = db.query<EventRow, []>(`
    select * from events where ${where} and timestamp_ms=(
      select timestamp_ms from events where ${where}
      order by timestamp_ms desc, path desc, byte_offset desc limit 1
    )
    order by ${tieOrder} limit 1
  `).get();
  return row ? recordFromRow(row) : undefined;
}

export function recentRecords(db: Database, limit: number): UsageRecord[] {
  const rows = db.query<EventRow, [number]>(`
    select * from events
    order by timestamp_ms desc, path desc, byte_offset desc limit ?
  `).all(limit);
  rows.reverse();
  return rows.map(recordFromRow);
}

export function recordFromRow(row: EventRow): UsageRecord {
  const info = parseObject(row.info_json) as TokenInfo | undefined;
  const limits = parseObject(row.limits_json) as RateLimits | undefined;
  return {
    event: {
      timestamp: row.timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        ...(info ? { info } : {}),
        ...(limits ? { rate_limits: limits } : {})
      }
    },
    meta: { cwd: row.cwd, id: row.session_id }
  };
}

export function bucketFromRow(row: BucketRow): UsageBucket {
  return {
    events: row.events,
    meta: { cwd: row.cwd, id: row.session_id },
    timestamp: new Date(row.timestamp_ms).toISOString(),
    usage: usageFromRow(row)
  };
}

export function usageFromRow(row: UsageRow): TokenUsage {
  return {
    cached_input_tokens: row.cached_input_tokens,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    reasoning_output_tokens: row.reasoning_output_tokens,
    total_tokens: row.total_tokens
  };
}

export function parseObject(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
}
