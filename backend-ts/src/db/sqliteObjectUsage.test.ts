import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { sqliteObjectUsage } from "./sqliteObjectUsage.ts";

test("SQLite object usage falls back to logical table bytes when dbstat is unavailable", () => {
  const sqlite = new Database(":memory:");
  try {
    sqlite.run("create table example (id integer primary key, value text not null)");
    sqlite.run("create index idx_example_value on example(value)");
    sqlite.run("insert into example (id, value) values (1, 'hello'), (2, 'world')");

    expect(sqliteObjectUsage(sqlite, ["example", "idx_example_value"], { forceLogicalFallback: true }))
      .toEqual([{ bytes: 12, name: "example" }]);
  } finally {
    sqlite.close();
  }
});
