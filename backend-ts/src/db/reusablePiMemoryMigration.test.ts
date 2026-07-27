import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runMigrations } from "./migrations.ts";
import { migrations } from "./schema/index.ts";

const MIGRATION_ID = "062_reusable_pi_memory";

describe("reusable PI memory migration", () => {
  test("backfills stable keys and occurrence metadata idempotently", () => {
    const db = new Database(":memory:");
    try {
      const index = migrations.findIndex((migration) => migration.id === MIGRATION_ID);
      expect(index).toBeGreaterThan(0);
      runMigrations(db, migrations.slice(0, index));
      db.run(`insert into pi_memory_items
        (id, scope, scope_id, kind, content, source_type, source_id, confidence, pinned, disabled, created_at, updated_at)
        values ('legacy', 'project', 'demo', 'project_observation', 'legacy status', 'pi.manager_cycle', 'cycle', 'high', 0, 1,
          '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')`);

      runMigrations(db, migrations);
      runMigrations(db, migrations);

      expect(db.query(`select memory_key, occurrence_count, last_seen_at
        from pi_memory_items where id='legacy'`).get()).toEqual({
        last_seen_at: "2026-01-02T00:00:00Z",
        memory_key: "legacy",
        occurrence_count: 1
      });
      expect(db.query("pragma index_list(pi_memory_items)").all())
        .toContainEqual(expect.objectContaining({ name: "ux_pi_memory_scope_key", unique: 1 }));
    } finally {
      db.close();
    }
  });
});
