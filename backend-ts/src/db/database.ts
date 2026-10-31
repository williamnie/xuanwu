import { Database as SQLiteDatabase } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { buildRunnerPaths } from "../config/paths.ts";
import { ensureDefaultPiAgent } from "./defaultPiAgent.ts";
import { ensureDefaultPiPersona } from "./defaultPiPersona.ts";
import { runMigrations } from "./migrations.ts";
import { ISSUE_EVENT_QUERY_INDEX_NAMES } from "./schema/075_issue_event_query_indexes.ts";
import { GUARDIAN_INBOX_ACTIVE_INDEX } from "./schema/094_guardian_inbox_active_index.ts";
import { sqlSlowTraceThreshold, traceSlowSQLiteQueries } from "./slowQueryTrace.ts";

type OpenDatabaseOptions = {
  dbPath?: string;
  readonlyImportPath?: string;
  stateDir?: string;
  writerBusyTimeoutMs?: number;
};

export const WRITER_BUSY_TIMEOUT_MS = 250;
export const READONLY_BUSY_TIMEOUT_MS = 50;
export const WAL_AUTOCHECKPOINT_PAGES = 1000;
const QUERY_PLANNER_ANALYSIS_LIMIT = 1000;
const QUERY_PLANNER_OPTIMIZE_INTERVAL_MS = 6 * 60 * 60 * 1000;

type TransactionRunner<A extends any[], T> = {
  (...args: A): T;
  deferred(...args: A): T;
  exclusive(...args: A): T;
  immediate(...args: A): T;
};

export type RunnerDatabase = {
  close(): void;
  connectionRole?: "reader" | "writer";
  path: string;
  readonly: boolean;
  sqlite: SQLiteDatabase;
  transaction<A extends any[], T>(inside: (...args: A) => T): TransactionRunner<A, T>;
};

export async function openDatabase(options: OpenDatabaseOptions = {}): Promise<RunnerDatabase> {
  const target = resolveDatabaseTarget(options);
  if (!target.readonly) await createRuntimeDirectories(target.stateDir, target.path);

  const sqlite = new SQLiteDatabase(target.path, {
    create: !target.readonly,
    readonly: target.readonly,
    readwrite: !target.readonly,
    strict: true
  });
  try {
    const writerBusyTimeout = boundedWriterBusyTimeout(options.writerBusyTimeoutMs);
    sqlite.run(`pragma busy_timeout = ${target.readonly ? READONLY_BUSY_TIMEOUT_MS : writerBusyTimeout}`);
    sqlite.run("pragma foreign_keys = on");
    if (target.readonly) sqlite.run("pragma query_only = on");
    if (!target.readonly) {
      runMigrations(sqlite);
      assertRuntimeSchema(sqlite);
      ensureDefaultPiAgent({ readonly: false, sqlite });
      ensureDefaultPiPersona({ readonly: false, sqlite });
      configureWalConnection(sqlite);
      refreshQueryPlannerStatistics(sqlite, 0x10002);
    }

    const connectionRole = target.readonly ? "reader" : "writer";
    const tracedSqlite = traceSlowSQLiteQueries(sqlite, {
      connectionRole,
      slowThresholdMs: sqlSlowTraceThreshold()
    });
    const optimizeTimer = target.readonly
      ? undefined
      : setInterval(() => refreshQueryPlannerStatistics(sqlite), QUERY_PLANNER_OPTIMIZE_INTERVAL_MS);
    optimizeTimer?.unref?.();
    return {
      connectionRole,
      path: target.path,
      readonly: target.readonly,
      sqlite: tracedSqlite,
      close: () => {
        if (optimizeTimer) clearInterval(optimizeTimer);
        sqlite.close();
      },
      transaction: (inside) => tracedSqlite.transaction(inside)
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

function assertRuntimeSchema(sqlite: SQLiteDatabase): void {
  const requiredIndexes = [...ISSUE_EVENT_QUERY_INDEX_NAMES, GUARDIAN_INBOX_ACTIVE_INDEX];
  const missing = requiredIndexes.filter((name) => !sqlite.query<{ name: string }, [string]>(
    "select name from sqlite_master where type='index' and name=?"
  ).get(name));
  if (missing.length > 0) {
    throw new Error(`Runner database schema invariant failed: missing required indexes: ${missing.join(", ")}`);
  }
}

function boundedWriterBusyTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= WRITER_BUSY_TIMEOUT_MS
    ? Math.min(value, 30_000)
    : WRITER_BUSY_TIMEOUT_MS;
}

/**
 * WAL is enabled only by the audited maintenance cutover. Runtime startup must
 * never perform that state transition implicitly; it only applies per-connection
 * settings after the database has already been switched.
 */
function configureWalConnection(sqlite: SQLiteDatabase): void {
  const mode = String(sqlite.query<Record<string, unknown>, []>("pragma journal_mode").get()?.journal_mode ?? "");
  if (mode.toLowerCase() !== "wal") return;
  sqlite.run("pragma synchronous = normal");
  sqlite.run(`pragma wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`);
}

/**
 * 运行时从不显式 ANALYZE；长连接按 SQLite 建议在打开时与定期执行 optimize，
 * 让规划器拿到索引选择性统计。analysis_limit 限制每张表的采样成本，失败只影响统计新鲜度。
 */
function refreshQueryPlannerStatistics(sqlite: SQLiteDatabase, mask?: number): void {
  try {
    sqlite.run(`pragma analysis_limit = ${QUERY_PLANNER_ANALYSIS_LIMIT}`);
    sqlite.run(mask === undefined ? "pragma optimize" : `pragma optimize = ${mask}`);
  } catch {
    // 统计刷新是尽力而为；忙锁或只读介质不应阻断启动与业务写入。
  }
}

type DatabaseTarget = { path: string; readonly: boolean; stateDir: string };

function resolveDatabaseTarget(options: OpenDatabaseOptions): DatabaseTarget {
  const importPath = cleanPath(options.readonlyImportPath);
  if (importPath) return { path: importPath, readonly: true, stateDir: dirname(importPath) };
  const paths = buildRunnerPaths({ dbPath: options.dbPath, stateDir: options.stateDir });
  return { path: paths.dbPath, readonly: false, stateDir: paths.stateDir };
}

async function createRuntimeDirectories(stateDir: string, dbPath: string): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await mkdir(dirname(dbPath), { recursive: true });
}

function cleanPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}
