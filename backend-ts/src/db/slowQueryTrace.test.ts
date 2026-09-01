import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  DEFAULT_SQL_SLOW_TRACE_MS,
  SQL_SLOW_TRACE_ENV,
  sqlSlowTraceThreshold,
  sqlTraceShape,
  traceSlowSQLiteQueries
} from "./slowQueryTrace.ts";

describe("SQLite slow query trace", () => {
  test("logs a redacted query shape, duration, caller and row count without bindings", () => {
    const sqlite = new Database(":memory:");
    const entries: Array<Record<string, unknown>> = [];
    const clock = sequenceClock([100, 365.125]);
    const traced = traceSlowSQLiteQueries(sqlite, {
      clock,
      connectionRole: "reader",
      emit: (entry) => entries.push(entry),
      slowThresholdMs: 250
    });
    try {
      const row = traced.query<{ secret: string; value: number }, []>(
        "select 'private-value' as secret, 42 as value -- hidden-comment"
      ).get();

      expect(row).toEqual({ secret: "private-value", value: 42 });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        binding_count: 0,
        connection_role: "reader",
        duration_ms: 265.125,
        event: "runner.sqlite_query_slow",
        method: "get",
        rows: 1,
        sql_preview: "select ? as secret, ? as value"
      });
      expect(String(entries[0]?.caller)).toContain("slowQueryTrace.test.ts");
      expect(String(entries[0]?.sql_fingerprint)).toMatch(/^[a-f0-9]{16}$/);
      expect(JSON.stringify(entries[0])).not.toContain("private-value");
      expect(JSON.stringify(entries[0])).not.toContain("hidden-comment");
    } finally {
      sqlite.close();
    }
  });

  test("preserves statement and database mutation results while tracing only slow executions", () => {
    const sqlite = new Database(":memory:");
    sqlite.run("create table item (id integer primary key, name text not null)");
    const entries: Array<Record<string, unknown>> = [];
    const traced = traceSlowSQLiteQueries(sqlite, {
      clock: sequenceClock([0, 1, 10, 310]),
      connectionRole: "writer",
      emit: (entry) => entries.push(entry),
      slowThresholdMs: 250
    });
    try {
      const fast = traced.query("select count(*) as count from item").get();
      const inserted = traced.run("insert into item (name) values (?)", ["private-name"]);

      expect(fast).toEqual({ count: 0 });
      expect(inserted.changes).toBe(1);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        binding_count: 1,
        connection_role: "writer",
        duration_ms: 300,
        event: "runner.sqlite_query_slow",
        method: "database_run",
        rows: 1
      });
      expect(JSON.stringify(entries[0])).not.toContain("private-name");
    } finally {
      sqlite.close();
    }
  });

  test("traces iterator consumption through completion", () => {
    const sqlite = new Database(":memory:");
    sqlite.run("create table item (id integer primary key)");
    sqlite.run("insert into item values (1), (2), (3)");
    const entries: Array<Record<string, unknown>> = [];
    const traced = traceSlowSQLiteQueries(sqlite, {
      clock: sequenceClock([0, 500]),
      connectionRole: "reader",
      emit: (entry) => entries.push(entry),
      slowThresholdMs: 250
    });
    try {
      expect([...traced.query<{ id: number }, []>("select id from item order by id").iterate()])
        .toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
      expect(entries[0]).toMatchObject({ method: "iterate", rows: 3, duration_ms: 500 });
    } finally {
      sqlite.close();
    }
  });

  test("supports a production default and explicit disable switch", () => {
    expect(sqlSlowTraceThreshold({})).toBe(DEFAULT_SQL_SLOW_TRACE_MS);
    expect(sqlSlowTraceThreshold({ [SQL_SLOW_TRACE_ENV]: "125" })).toBe(125);
    expect(sqlSlowTraceThreshold({ [SQL_SLOW_TRACE_ENV]: "0" })).toBe(Number.POSITIVE_INFINITY);
    expect(sqlSlowTraceThreshold({ [SQL_SLOW_TRACE_ENV]: "invalid" })).toBe(DEFAULT_SQL_SLOW_TRACE_MS);
  });

  test("fingerprints the redacted shape rather than literal values", () => {
    expect(sqlTraceShape("select * from item where token='one' and id=42"))
      .toEqual(sqlTraceShape("select * from item where token='two' and id=99"));
  });
});

function sequenceClock(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}
