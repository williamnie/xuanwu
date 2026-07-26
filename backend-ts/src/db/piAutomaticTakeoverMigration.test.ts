import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runMigrations } from "./migrations.ts";
import { migrations } from "./schema/index.ts";

const MIGRATION_ID = "059_pi_automatic_takeover";

describe("PI automatic takeover migration", () => {
  test("turns project PI settings into a presence-only binding and preserves policies", () => {
    const db = new Database(":memory:");
    try {
      const index = migrations.findIndex((migration) => migration.id === MIGRATION_ID);
      expect(index).toBeGreaterThan(0);
      runMigrations(db, migrations.slice(0, index));
      db.run(`insert into projects (id, name, cwd, created_at, updated_at)
        values ('demo', 'Demo', '/tmp/demo', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
      db.run(`insert into project_pi_settings (
        project_id, pi_agent_id, auto_manage, auto_triage, auto_enqueue,
        notify_on_needs_user, max_actions_per_cycle, created_at, updated_at
      ) values (
        'demo', 'runner-default', 0, 0, 0, 1, 3,
        '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
      )`);
      db.run(`insert into project_pi_policies (
        project_id, default_mode, supervisor_mode, timezone, created_at, updated_at
      ) values (
        'demo', 'manual', 'off', 'Asia/Shanghai',
        '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
      )`);

      runMigrations(db, migrations);
      runMigrations(db, migrations);

      expect(columnNames(db, "project_pi_settings")).toEqual(["project_id", "created_at", "updated_at"]);
      expect(columnNames(db, "project_pi_policies")).not.toContain("default_mode");
      expect(columnNames(db, "project_pi_policies")).not.toContain("supervisor_mode");
      expect(db.query("select * from project_pi_settings").get()).toEqual({
        created_at: "2026-01-01T00:00:00Z",
        project_id: "demo",
        updated_at: "2026-01-01T00:00:00Z"
      });
      expect(db.query("select timezone from project_pi_policies where project_id='demo'").get())
        .toEqual({ timezone: "Asia/Shanghai" });
      expect(db.query("select auto_run from projects where id='demo'").get()).toEqual({ auto_run: 1 });
    } finally {
      db.close();
    }
  });
});

function columnNames(db: Database, table: string): string[] {
  return db.query<{ name: string }, []>(`pragma table_info(${table})`).all().map((row) => row.name);
}
