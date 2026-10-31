import { Database } from "bun:sqlite";
import { tokenUsage } from "./helpers.ts";
import type { TokenInfo, UsageMeta } from "./types.ts";
import { USAGE_INDEX_VERSION } from "./usageIndex.model.ts";
import type { FileRow, StoredFileRow, FileDescriptor, UsageIndexMetrics } from "./usageIndex.model.ts";
import { setMetadata, metadataNumber } from "./usageIndex.metadata.ts";
import type { tailChecksum } from "./usageIndex.filesystem.ts";
import { UPSERT_FILE } from "./usageIndex.sql.ts";

export function compactInfo(info: TokenInfo): TokenInfo {
  return {
    last_token_usage: tokenUsage(info.last_token_usage),
    model_context_window: typeof info.model_context_window === "number" ? info.model_context_window : 0,
    total_token_usage: tokenUsage(info.total_token_usage)
  };
}

export function createSchema(db: Database, root: string): void {
  db.run(`
    create table metadata (key text primary key, value text not null);
    create table files (
      path text primary key,
      inode text not null,
      size integer not null,
      mtime_ms real not null,
      offset integer not null,
      tail_checksum text not null,
      last_cwd text not null,
      last_session_id text not null,
      corrupt_lines integer not null
    );
    create table events (
      path text not null,
      byte_offset integer not null,
      timestamp_ms integer not null,
      timestamp text not null,
      cwd text not null,
      session_id text not null,
      info_json text,
      limits_json text,
      cached_input_tokens integer not null,
      input_tokens integer not null,
      output_tokens integer not null,
      reasoning_output_tokens integer not null,
      total_tokens integer not null,
      primary key (path, byte_offset)
    ) without rowid;
    create index events_recent on events(timestamp_ms desc, path desc, byte_offset desc);
    create table buckets (
      path text not null,
      day text not null,
      cwd text not null,
      session_id text not null,
      timestamp_ms integer not null,
      events integer not null,
      cached_input_tokens integer not null,
      input_tokens integer not null,
      output_tokens integer not null,
      reasoning_output_tokens integer not null,
      total_tokens integer not null,
      primary key (path, day, cwd, session_id)
    ) without rowid;
  `);
  db.run(`pragma user_version = ${USAGE_INDEX_VERSION}`);
  setMetadata(db, "source_root", root);
}

export function openWritable(path: string, existing: boolean): Database {
  const db = new Database(path, { create: !existing, readwrite: true, strict: true });
  db.run("pragma busy_timeout = 5000");
  db.run(`pragma journal_mode = ${existing ? "wal" : "delete"}`);
  db.run("pragma synchronous = full");
  return db;
}

export function fileRows(db: Database): Map<string, FileRow> {
  const rows = db.query<StoredFileRow, []>("select * from files").all();
  return new Map(rows.map((row) => [row.path, {
    corruptLines: row.corrupt_lines,
    inode: row.inode,
    lastMeta: { cwd: row.last_cwd, id: row.last_session_id },
    mtimeMs: row.mtime_ms,
    offset: row.offset,
    path: row.path,
    size: row.size,
    tailChecksum: row.tail_checksum
  }]));
}

export function upsertFile(
  db: Database,
  descriptor: FileDescriptor,
  scan: { corruptLines: number; lastMeta: UsageMeta; offset: number; tailChecksum: string }
): void {
  db.query(UPSERT_FILE).run(
    descriptor.path,
    descriptor.inode,
    descriptor.size,
    descriptor.mtimeMs,
    scan.offset,
    scan.tailChecksum,
    scan.lastMeta.cwd,
    scan.lastMeta.id,
    scan.corruptLines
  );
}

export function deleteFileRows(db: Database, path: string): void {
  db.query("delete from events where path=?").run(path);
  db.query("delete from buckets where path=?").run(path);
  db.query("delete from files where path=?").run(path);
}

export function writeMetrics(db: Database, root: string, metrics: UsageIndexMetrics): void {
  setMetadata(db, "source_root", root);
  setMetadata(db, "indexed_at", new Date().toISOString());
  for (const [key, value] of Object.entries(metrics)) setMetadata(db, `metric.${key}`, String(value));
}

export function storedMetrics(db: Database): UsageIndexMetrics {
  return {
    bytes_read: metadataNumber(db, "metric.bytes_read"),
    corrupt_lines: metadataNumber(db, "metric.corrupt_lines"),
    files_incremental: metadataNumber(db, "metric.files_incremental"),
    files_reused: metadataNumber(db, "metric.files_reused"),
    files_scanned: metadataNumber(db, "metric.files_scanned"),
    files_total: metadataNumber(db, "metric.files_total"),
    index_hits: metadataNumber(db, "metric.index_hits"),
    index_rebuilds: metadataNumber(db, "metric.index_rebuilds")
  };
}
