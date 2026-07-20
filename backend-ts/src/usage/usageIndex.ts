import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { basename } from "node:path";
import { clean, dayKey, timestamp, timestampMs, tokenUsage } from "./helpers.ts";
import type { RateLimits, TokenEvent, TokenInfo, TokenUsage, UsageBucket, UsageMeta, UsageRecord } from "./types.ts";

export const USAGE_INDEX_VERSION = 1;
const TAIL_BYTES = 4096;
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const LOCK_STALE_MS = 10 * 60 * 1000;
const WORKER_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_RECENT_RECORD_LIMIT = 1000;

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

type FileDescriptor = { inode: string; mtimeMs: number; path: string; size: number };
type FileRow = FileDescriptor & {
  corruptLines: number;
  lastMeta: UsageMeta;
  offset: number;
  tailChecksum: string;
};
type QueryState = { lastError?: string; refreshing: boolean };

export async function refreshUsageIndex(
  root: string,
  indexPath: string,
  options: { forceRebuild?: boolean } = {}
): Promise<UsageIndexMetrics> {
  await mkdir(dirname(indexPath), { recursive: true });
  const release = await acquireLock(`${indexPath}.lock`);
  try {
    const rebuild = options.forceRebuild || !usageIndexIsValid(indexPath, root);
    if (rebuild) return await rebuildIndex(root, indexPath);
    return await updateIndex(root, indexPath);
  } finally {
    await release();
  }
}

export async function refreshUsageIndexInWorker(
  root: string,
  indexPath: string,
  options: { forceRebuild?: boolean } = {}
): Promise<UsageIndexMetrics> {
  const workerArgs = ["__usage-index-worker", root, indexPath, options.forceRebuild ? "1" : "0", String(process.pid)];
  const command = basename(process.execPath).startsWith("bun")
    ? [process.execPath, join(import.meta.dir, "../main.ts"), ...workerArgs]
    : [process.execPath, ...workerArgs];
  const child = Bun.spawn({
    cmd: command,
    env: workerEnvironment(),
    stderr: "pipe",
    stdout: "pipe"
  });
  const timeout = setTimeout(() => child.kill(), WORKER_TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]).finally(() => clearTimeout(timeout));
  if (exitCode !== 0) throw new Error(`usage index worker failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
  const parsed = JSON.parse(stdout) as { metrics?: UsageIndexMetrics; ok?: boolean };
  if (!parsed.ok || !parsed.metrics) throw new Error("usage index worker returned an invalid result");
  return parsed.metrics;
}

function workerEnvironment(): Record<string, string> {
  return Object.fromEntries(["HOME", "PATH", "TMPDIR", "TZ"]
    .map((key) => [key, Bun.env[key] ?? ""])
    .filter(([, value]) => value !== ""));
}

export function usageIndexIsValid(indexPath: string, root: string): boolean {
  if (!existsSync(indexPath)) return false;
  let db: Database | undefined;
  try {
    db = new Database(indexPath, { readonly: true, strict: true });
    const version = scalarNumber(db, "pragma user_version");
    const source = metadata(db, "source_root");
    const check = scalarText(db, "pragma quick_check");
    return version === USAGE_INDEX_VERSION && source === root && check === "ok";
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

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

async function rebuildIndex(root: string, indexPath: string): Promise<UsageIndexMetrics> {
  await cleanupAbandonedIndexes(indexPath);
  const temp = `${indexPath}.tmp-${process.pid}-${Date.now()}`;
  await removeSQLiteFiles(temp);
  const db = openWritable(temp, false);
  try {
    createSchema(db, root);
    const metrics = await applyFilesystemSnapshot(db, root, true);
    db.run("pragma wal_checkpoint(truncate)");
    db.close();
    await removeSQLiteSidecars(indexPath);
    await rename(temp, indexPath);
    return metrics;
  } catch (error) {
    try { db.run("rollback"); } catch { /* no active transaction */ }
    try { db.close(); } catch { /* already closed */ }
    await removeSQLiteFiles(temp);
    throw error;
  }
}

async function updateIndex(root: string, indexPath: string): Promise<UsageIndexMetrics> {
  const db = openWritable(indexPath, true);
  try {
    return await applyFilesystemSnapshot(db, root, false);
  } finally {
    db.close();
  }
}

async function applyFilesystemSnapshot(db: Database, root: string, rebuilt: boolean): Promise<UsageIndexMetrics> {
  const descriptors = await jsonlFileDescriptors(root);
  const previous = fileRows(db);
  const metrics: UsageIndexMetrics = {
    bytes_read: 0,
    corrupt_lines: 0,
    files_incremental: 0,
    files_reused: 0,
    files_scanned: 0,
    files_total: descriptors.length,
    index_hits: 0,
    index_rebuilds: rebuilt ? 1 : 0
  };
  const plans = await Promise.all(descriptors.map(async (descriptor) => ({
    descriptor,
    mode: await updateMode(descriptor, previous.get(descriptor.path))
  })));

  db.run("begin immediate");
  try {
    const livePaths = new Set(descriptors.map((item) => item.path));
    for (const path of previous.keys()) {
      if (!livePaths.has(path)) deleteFileRows(db, path);
    }
    for (const plan of plans) {
      const old = previous.get(plan.descriptor.path);
      if (plan.mode === "reuse" && old) {
        metrics.files_reused += 1;
        metrics.corrupt_lines += old.corruptLines;
        continue;
      }
      if (plan.mode === "scan") {
        deleteFileRows(db, plan.descriptor.path);
        metrics.files_scanned += 1;
      } else {
        metrics.files_incremental += 1;
      }
      const start = plan.mode === "append" ? old?.offset ?? 0 : 0;
      const initialMeta = plan.mode === "append" ? old?.lastMeta ?? emptyMeta() : emptyMeta();
      const initialCorrupt = plan.mode === "append" ? old?.corruptLines ?? 0 : 0;
      const scan = await scanFile(db, plan.descriptor, start, initialMeta, initialCorrupt);
      metrics.bytes_read += scan.bytesRead;
      metrics.corrupt_lines += scan.corruptLines;
      upsertFile(db, plan.descriptor, scan);
    }
    writeMetrics(db, root, metrics);
    db.run("commit");
    return metrics;
  } catch (error) {
    db.run("rollback");
    throw error;
  }
}

async function updateMode(descriptor: FileDescriptor, old: FileRow | undefined): Promise<"append" | "reuse" | "scan"> {
  if (!old) return "scan";
  if (descriptor.inode !== old.inode) return "scan";
  if (descriptor.size === old.size && descriptor.mtimeMs === old.mtimeMs) return "reuse";
  if (descriptor.size <= old.size || descriptor.mtimeMs < old.mtimeMs) return "scan";
  return await tailChecksum(descriptor.path, old.offset) === old.tailChecksum ? "append" : "scan";
}

async function scanFile(
  db: Database,
  descriptor: FileDescriptor,
  start: number,
  initialMeta: UsageMeta,
  initialCorrupt: number
): Promise<{ bytesRead: number; corruptLines: number; lastMeta: UsageMeta; offset: number; tailChecksum: string }> {
  const meta = { ...initialMeta };
  let corruptLines = initialCorrupt;
  let offset = start;
  let pending = Buffer.alloc(0);
  let pendingStart = start;
  let droppingOversize = false;
  if (descriptor.size <= start) {
    return {
      bytesRead: 0,
      corruptLines,
      lastMeta: meta,
      offset: start,
      tailChecksum: await tailChecksum(descriptor.path, start)
    };
  }
  const handle = await open(descriptor.path, "r");
  try {
    let position = start;
    while (position < descriptor.size) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, descriptor.size - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      const value = bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead);
      pending = pending.length === 0 ? value : Buffer.concat([pending, value]);
      while (true) {
        const newline = pending.indexOf(0x0a);
        if (newline < 0) break;
        const line = pending.subarray(0, newline > 0 && pending[newline - 1] === 0x0d ? newline - 1 : newline);
        if (droppingOversize) {
          corruptLines += 1;
          droppingOversize = false;
        } else {
          corruptLines += processLine(db, descriptor.path, pendingStart, line, meta) ? 0 : 1;
        }
        const consumed = newline + 1;
        pendingStart += consumed;
        offset = pendingStart;
        pending = pending.subarray(consumed);
      }
      if (pending.length > MAX_LINE_BYTES) {
        pendingStart += pending.length;
        pending = Buffer.alloc(0);
        droppingOversize = true;
      }
    }
  } finally {
    await handle.close();
  }
  if (!droppingOversize && pending.length > 0) {
    const valid = processLine(db, descriptor.path, pendingStart, pending, meta);
    if (valid) offset = descriptor.size;
  }
  return {
    bytesRead: Math.max(0, descriptor.size - start),
    corruptLines,
    lastMeta: meta,
    offset,
    tailChecksum: await tailChecksum(descriptor.path, offset)
  };
}

function processLine(db: Database, path: string, byteOffset: number, line: Buffer, meta: UsageMeta): boolean {
  const text = line.toString("utf8").trim();
  if (text === "") return true;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  const record = value as { payload?: { cwd?: unknown; id?: unknown; type?: unknown }; timestamp?: string; type?: unknown };
  if (record.type === "session_meta") {
    meta.cwd = clean(record.payload?.cwd);
    meta.id = clean(record.payload?.id);
    return true;
  }
  if (record.type !== "event_msg" || record.payload?.type !== "token_count") return true;
  const event = value as TokenEvent;
  insertEvent(db, path, byteOffset, event, meta);
  return true;
}

function insertEvent(db: Database, path: string, byteOffset: number, event: TokenEvent, meta: UsageMeta): void {
  const at = timestamp(event);
  const atMs = timestampMs(event);
  const info = event.payload?.info;
  const limits = event.payload?.rate_limits;
  const usage = tokenUsage(info?.last_token_usage);
  db.query(INSERT_EVENT).run(
    path,
    byteOffset,
    atMs,
    at.toISOString(),
    meta.cwd,
    meta.id,
    info ? JSON.stringify(compactInfo(info)) : null,
    limits ? JSON.stringify(limits) : null,
    usage.cached_input_tokens,
    usage.input_tokens,
    usage.output_tokens,
    usage.reasoning_output_tokens,
    usage.total_tokens
  );
  if (!info) return;
  db.query(UPSERT_BUCKET).run(
    path,
    dayKey(at),
    meta.cwd,
    meta.id,
    atMs,
    1,
    usage.cached_input_tokens,
    usage.input_tokens,
    usage.output_tokens,
    usage.reasoning_output_tokens,
    usage.total_tokens
  );
}

function compactInfo(info: TokenInfo): TokenInfo {
  return {
    last_token_usage: tokenUsage(info.last_token_usage),
    model_context_window: typeof info.model_context_window === "number" ? info.model_context_window : 0,
    total_token_usage: tokenUsage(info.total_token_usage)
  };
}

function createSchema(db: Database, root: string): void {
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

function openWritable(path: string, existing: boolean): Database {
  const db = new Database(path, { create: !existing, readwrite: true, strict: true });
  db.run("pragma busy_timeout = 5000");
  db.run(`pragma journal_mode = ${existing ? "wal" : "delete"}`);
  db.run("pragma synchronous = full");
  return db;
}

async function jsonlFileDescriptors(root: string): Promise<FileDescriptor[]> {
  const paths: string[] = [];
  await collectJsonlFiles(root, paths);
  paths.sort();
  return await Promise.all(paths.map(async (path) => {
    const value = await stat(path);
    return { inode: String(value.ino), mtimeMs: value.mtimeMs, path, size: value.size };
  }));
}

async function collectJsonlFiles(dir: string, files: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await collectJsonlFiles(path, files);
    else if (entry.isFile() && extname(entry.name) === ".jsonl") files.push(path);
  }
}

async function tailChecksum(path: string, offset: number): Promise<string> {
  const start = Math.max(0, offset - TAIL_BYTES);
  const length = Math.max(0, offset - start);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, start);
    return createHash("sha256").update(buffer).digest("hex");
  } finally {
    await handle.close();
  }
}

function fileRows(db: Database): Map<string, FileRow> {
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

function upsertFile(
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

function deleteFileRows(db: Database, path: string): void {
  db.query("delete from events where path=?").run(path);
  db.query("delete from buckets where path=?").run(path);
  db.query("delete from files where path=?").run(path);
}

function writeMetrics(db: Database, root: string, metrics: UsageIndexMetrics): void {
  setMetadata(db, "source_root", root);
  setMetadata(db, "indexed_at", new Date().toISOString());
  for (const [key, value] of Object.entries(metrics)) setMetadata(db, `metric.${key}`, String(value));
}

function storedMetrics(db: Database): UsageIndexMetrics {
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

function latestRecord(db: Database, where: string, tieOrder: string): UsageRecord | undefined {
  const row = db.query<EventRow, []>(`
    select * from events where ${where}
    order by timestamp_ms desc, ${tieOrder} limit 1
  `).get();
  return row ? recordFromRow(row) : undefined;
}

function recentRecords(db: Database, limit: number): UsageRecord[] {
  const rows = db.query<EventRow, [number]>(`
    select * from events
    order by timestamp_ms desc, path desc, byte_offset desc limit ?
  `).all(limit);
  rows.reverse();
  return rows.map(recordFromRow);
}

function recordFromRow(row: EventRow): UsageRecord {
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

function bucketFromRow(row: BucketRow): UsageBucket {
  return {
    events: row.events,
    meta: { cwd: row.cwd, id: row.session_id },
    timestamp: new Date(row.timestamp_ms).toISOString(),
    usage: usageFromRow(row)
  };
}

function usageFromRow(row: UsageRow): TokenUsage {
  return {
    cached_input_tokens: row.cached_input_tokens,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    reasoning_output_tokens: row.reasoning_output_tokens,
    total_tokens: row.total_tokens
  };
}

function parseObject(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
}

function metadata(db: Database, key: string): string {
  return db.query<{ value: string }, [string]>("select value from metadata where key=?").get(key)?.value ?? "";
}

function metadataNumber(db: Database, key: string): number {
  const value = Number(metadata(db, key));
  return Number.isFinite(value) ? value : 0;
}

function setMetadata(db: Database, key: string, value: string): void {
  db.query("insert into metadata(key,value) values(?,?) on conflict(key) do update set value=excluded.value").run(key, value);
}

function scalarNumber(db: Database, sql: string): number {
  const row = db.query<Record<string, unknown>, []>(sql).get() ?? {};
  const value = Number(Object.values(row)[0]);
  return Number.isFinite(value) ? value : 0;
}

function scalarText(db: Database, sql: string): string {
  const row = db.query<Record<string, unknown>, []>(sql).get() ?? {};
  return String(Object.values(row)[0] ?? "");
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(JSON.stringify({ created_at: new Date().toISOString(), pid: process.pid }));
      await handle.close();
      return async () => { await rm(path, { force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const value = await stat(path).catch(() => undefined);
      if (value && (Date.now() - value.mtimeMs > LOCK_STALE_MS || !await lockOwnerAlive(path))) {
        await rm(path, { force: true });
        continue;
      }
      await Bun.sleep(50);
    }
  }
  throw new Error("usage index refresh lock timeout");
}

async function lockOwnerAlive(path: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
    const pid = Number(value.pid);
    if (!Number.isInteger(pid) || pid <= 1) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cleanupAbandonedIndexes(indexPath: string): Promise<void> {
  const directory = dirname(indexPath);
  const prefix = `${basename(indexPath)}.tmp-`;
  for (const name of await readdir(directory)) {
    if (!name.startsWith(prefix)) continue;
    await rm(join(directory, name), { force: true });
  }
}

async function removeSQLiteFiles(path: string): Promise<void> {
  await rm(path, { force: true });
  await removeSQLiteSidecars(path);
}

async function removeSQLiteSidecars(path: string): Promise<void> {
  await rm(`${path}-wal`, { force: true });
  await rm(`${path}-shm`, { force: true });
}

function emptyMeta(): UsageMeta {
  return { cwd: "", id: "" };
}

type StoredFileRow = {
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
type UsageRow = {
  cached_input_tokens: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
};
type BucketRow = UsageRow & { cwd: string; events: number; session_id: string; timestamp_ms: number };
type EventRow = UsageRow & {
  byte_offset: number;
  cwd: string;
  info_json: string | null;
  limits_json: string | null;
  path: string;
  session_id: string;
  timestamp: string;
  timestamp_ms: number;
};

const BUCKET_QUERY = `
  select cwd, session_id, min(timestamp_ms) as timestamp_ms,
    sum(events) as events,
    sum(cached_input_tokens) as cached_input_tokens,
    sum(input_tokens) as input_tokens,
    sum(output_tokens) as output_tokens,
    sum(reasoning_output_tokens) as reasoning_output_tokens,
    sum(total_tokens) as total_tokens
  from buckets group by day, cwd, session_id
  order by day asc, cwd asc, session_id asc
`;

const INSERT_EVENT = `
  insert into events(
    path, byte_offset, timestamp_ms, timestamp, cwd, session_id, info_json, limits_json,
    cached_input_tokens, input_tokens, output_tokens, reasoning_output_tokens, total_tokens
  ) values(?,?,?,?,?,?,?,?,?,?,?,?,?)
`;

const UPSERT_BUCKET = `
  insert into buckets(
    path, day, cwd, session_id, timestamp_ms, events,
    cached_input_tokens, input_tokens, output_tokens, reasoning_output_tokens, total_tokens
  ) values(?,?,?,?,?,?,?,?,?,?,?)
  on conflict(path, day, cwd, session_id) do update set
    timestamp_ms=min(timestamp_ms, excluded.timestamp_ms),
    events=events+excluded.events,
    cached_input_tokens=cached_input_tokens+excluded.cached_input_tokens,
    input_tokens=input_tokens+excluded.input_tokens,
    output_tokens=output_tokens+excluded.output_tokens,
    reasoning_output_tokens=reasoning_output_tokens+excluded.reasoning_output_tokens,
    total_tokens=total_tokens+excluded.total_tokens
`;

const UPSERT_FILE = `
  insert into files(path,inode,size,mtime_ms,offset,tail_checksum,last_cwd,last_session_id,corrupt_lines)
  values(?,?,?,?,?,?,?,?,?)
  on conflict(path) do update set
    inode=excluded.inode,
    size=excluded.size,
    mtime_ms=excluded.mtime_ms,
    offset=excluded.offset,
    tail_checksum=excluded.tail_checksum,
    last_cwd=excluded.last_cwd,
    last_session_id=excluded.last_session_id,
    corrupt_lines=excluded.corrupt_lines
`;
