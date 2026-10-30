import { timestamp } from "./helpers.ts";
import type { UsageMeta } from "./types.ts";
import type { tailChecksum } from "./usageIndex.filesystem.ts";

export const USAGE_INDEX_VERSION = 1;

export const TAIL_BYTES = 4096;

export const MAX_LINE_BYTES = 64 * 1024 * 1024;

export const READ_CHUNK_BYTES = 64 * 1024;

export const LOCK_STALE_MS = 10 * 60 * 1000;

export const WORKER_TIMEOUT_MS = 30 * 60 * 1000;

export const DEFAULT_RECENT_RECORD_LIMIT = 1000;

export type UsageIndexMetrics = {
  bytes_read: number;
  corrupt_lines: number;
  files_incremental: number;
  files_reused: number;
  files_scanned: number;
  files_total: number;
  index_hits: number;
  index_rebuilds: number;
};

export type FileDescriptor = { inode: string; mtimeMs: number; path: string; size: number };

export type FileRow = FileDescriptor & {
  corruptLines: number;
  lastMeta: UsageMeta;
  offset: number;
  tailChecksum: string;
};

export type QueryState = { lastError?: string; refreshing: boolean };

export type RefreshOptions = { forceRebuild?: boolean; verifiedIndexIdentity?: string };

export type RefreshResult = { indexIdentity?: string; metrics: UsageIndexMetrics };

export function emptyMeta(): UsageMeta {
  return { cwd: "", id: "" };
}

export type StoredFileRow = {
  corrupt_lines: number;
  inode: string;
  last_cwd: string;
  last_session_id: string;
  mtime_ms: number;
  offset: number;
  path: string;
  size: number;
  tail_checksum: string;
};

export type UsageRow = {
  cached_input_tokens: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
};

export type BucketRow = UsageRow & { cwd: string; events: number; session_id: string; timestamp_ms: number };

export type EventRow = UsageRow & {
  byte_offset: number;
  cwd: string;
  info_json: string | null;
  limits_json: string | null;
  path: string;
  session_id: string;
  timestamp: string;
  timestamp_ms: number;
};
