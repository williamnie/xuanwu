import { createHash } from "node:crypto";
import type { Database as SQLiteDatabase, Statement } from "bun:sqlite";

export const SQL_SLOW_TRACE_ENV = "XUANWU_SQL_SLOW_TRACE_MS";
export const DEFAULT_SQL_SLOW_TRACE_MS = 250;

type ConnectionRole = "reader" | "writer";
type Clock = () => number;
type TraceMethod = "all" | "database_exec" | "database_run" | "get" | "iterate" | "raw" | "run" | "values";

type SlowQueryTraceOptions = {
  clock?: Clock;
  connectionRole: ConnectionRole;
  emit?: (entry: Record<string, unknown>) => void;
  slowThresholdMs?: number;
};

type QueryExecution = {
  bindingCount: number;
  method: TraceMethod;
  rowCount?: (value: unknown) => number | undefined;
  sql: string;
};

const STATEMENT_METHODS = new Set(["all", "get", "iterate", "raw", "run", "values"]);

/**
 * Wrap Bun's synchronous SQLite connection without changing its public contract.
 * Only slow executions and failures are emitted; bound values are never logged.
 */
export function traceSlowSQLiteQueries(
  sqlite: SQLiteDatabase,
  options: SlowQueryTraceOptions
): SQLiteDatabase {
  const thresholdMs = traceThreshold(options.slowThresholdMs);
  if (!Number.isFinite(thresholdMs)) return sqlite;
  const clock = options.clock ?? performance.now.bind(performance);
  const emit = options.emit ?? ((entry) => console.warn(JSON.stringify(entry)));

  const wrapStatement = <ReturnType, ParamsType extends any[]>(
    statement: Statement<ReturnType, ParamsType>,
    sql: string
  ): Statement<ReturnType, ParamsType> => new Proxy(statement, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof property !== "string" || !STATEMENT_METHODS.has(property) || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      if (property === "iterate") {
        return (...bindings: unknown[]) => tracedIterator(
          Reflect.apply(value, target, bindings) as IterableIterator<ReturnType>,
          execution(property, sql, bindings, () => undefined),
          { clock, emit, options, thresholdMs }
        );
      }
      return (...bindings: unknown[]) => traceExecution(
        execution(property as Exclude<TraceMethod, "iterate">, sql, bindings, rowCounter(property)),
        { clock, emit, options, thresholdMs },
        () => Reflect.apply(value, target, bindings)
      );
    }
  }) as Statement<ReturnType, ParamsType>;

  return new Proxy(sqlite, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if ((property === "query" || property === "prepare") && typeof value === "function") {
        return (...args: unknown[]) => {
          const statement = Reflect.apply(value, target, args) as Statement<unknown, any[]>;
          return wrapStatement(statement, String(args[0] ?? ""));
        };
      }
      if ((property === "run" || property === "exec") && typeof value === "function") {
        return (sql: string, ...bindings: unknown[]) => traceExecution(
          execution(property === "run" ? "database_run" : "database_exec", sql, bindings, changesCount),
          { clock, emit, options, thresholdMs },
          () => Reflect.apply(value, target, [sql, ...bindings])
        );
      }
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as SQLiteDatabase;
}

export function sqlSlowTraceThreshold(env: Record<string, string | undefined> = Bun.env): number {
  const raw = env[SQL_SLOW_TRACE_ENV]?.trim() ?? "";
  if (raw === "") return DEFAULT_SQL_SLOW_TRACE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SQL_SLOW_TRACE_MS;
  return parsed === 0 ? Number.POSITIVE_INFINITY : parsed;
}

export function sqlTraceShape(sql: string): { fingerprint: string; preview: string } {
  const preview = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\r\n]*/g, " ")
    .replace(/\b[xX]'(?:''|[^'])*'/g, "?")
    .replace(/'(?:''|[^'])*'/g, "?")
    .replace(/\b\d+(?:\.\d+)?\b/g, "?")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 480);
  return {
    fingerprint: createHash("sha256").update(preview).digest("hex").slice(0, 16),
    preview
  };
}

function traceExecution<T>(
  query: QueryExecution,
  runtime: TraceRuntime,
  operation: () => T
): T {
  const startedAt = runtime.clock();
  try {
    const value = operation();
    const durationMs = runtime.clock() - startedAt;
    if (durationMs >= runtime.thresholdMs) {
      runtime.emit(traceEntry("runner.sqlite_query_slow", query, runtime.options, durationMs, query.rowCount?.(value)));
    }
    return value;
  } catch (error) {
    const durationMs = runtime.clock() - startedAt;
    if (durationMs >= runtime.thresholdMs) {
      runtime.emit({
        ...traceEntry("runner.sqlite_query_failed", query, runtime.options, durationMs),
        error_code: errorCode(error),
        error_name: error instanceof Error ? error.name : "Error"
      });
    }
    throw error;
  }
}

type TraceRuntime = {
  clock: Clock;
  emit: (entry: Record<string, unknown>) => void;
  options: SlowQueryTraceOptions;
  thresholdMs: number;
};

function tracedIterator<T>(
  iterator: IterableIterator<T>,
  query: QueryExecution,
  runtime: TraceRuntime
): IterableIterator<T> {
  const startedAt = runtime.clock();
  let finished = false;
  let rows = 0;
  const finish = (error?: unknown) => {
    if (finished) return;
    finished = true;
    const durationMs = runtime.clock() - startedAt;
    if (error !== undefined) {
      if (durationMs >= runtime.thresholdMs) {
        runtime.emit({
          ...traceEntry("runner.sqlite_query_failed", query, runtime.options, durationMs, rows),
          error_code: errorCode(error),
          error_name: error instanceof Error ? error.name : "Error"
        });
      }
    } else if (durationMs >= runtime.thresholdMs) {
      runtime.emit(traceEntry("runner.sqlite_query_slow", query, runtime.options, durationMs, rows));
    }
  };
  return {
    next(...args: [] | [undefined]) {
      try {
        const result = iterator.next(...args);
        if (result.done) finish();
        else rows += 1;
        return result;
      } catch (error) {
        finish(error);
        throw error;
      }
    },
    return(value?: unknown) {
      try {
        const result = iterator.return?.(value as T) ?? { done: true, value: value as T };
        finish();
        return result;
      } catch (error) {
        finish(error);
        throw error;
      }
    },
    throw(error?: unknown) {
      try {
        const result = iterator.throw?.(error) ?? (() => { throw error; })();
        return result;
      } catch (caught) {
        finish(caught);
        throw caught;
      }
    },
    [Symbol.iterator]() { return this; }
  };
}

function execution(
  method: TraceMethod,
  sql: string,
  bindings: unknown[],
  rowCount: QueryExecution["rowCount"]
): QueryExecution {
  return { bindingCount: bindingCount(bindings), method, rowCount, sql };
}

function traceEntry(
  event: string,
  query: QueryExecution,
  options: SlowQueryTraceOptions,
  durationMs: number,
  rows?: number
): Record<string, unknown> {
  const shape = sqlTraceShape(query.sql);
  return {
    binding_count: query.bindingCount,
    caller: queryCaller(),
    connection_role: options.connectionRole,
    duration_ms: roundedMs(durationMs),
    event,
    method: query.method,
    ...(rows === undefined ? {} : { rows }),
    sql_fingerprint: shape.fingerprint,
    sql_preview: shape.preview
  };
}

function bindingCount(bindings: unknown[]): number {
  if (bindings.length === 1 && Array.isArray(bindings[0])) return bindings[0].length;
  return bindings.length;
}

function rowCounter(method: string): (value: unknown) => number | undefined {
  if (["all", "raw", "values"].includes(method)) return (value) => Array.isArray(value) ? value.length : undefined;
  if (method === "get") return (value) => value === null || value === undefined ? 0 : 1;
  return changesCount;
}

function changesCount(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const changes = Number((value as Record<string, unknown>).changes);
  return Number.isFinite(changes) ? changes : undefined;
}

function queryCaller(): string {
  const frames = new Error().stack?.split("\n").slice(2).map((frame) => frame.trim()) ?? [];
  const caller = frames.find((frame) => !frame.includes("slowQueryTrace.ts")) ?? "";
  return caller.slice(0, 320);
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" || typeof code === "number" ? String(code).slice(0, 80) : "";
}

function traceThreshold(value: number | undefined): number {
  if (value === undefined) return DEFAULT_SQL_SLOW_TRACE_MS;
  if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY;
  return Math.max(0, value);
}

function roundedMs(value: number): number {
  return Math.round(Math.max(0, value) * 1000) / 1000;
}
