import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runMigrations } from "./migrations.ts";
import { migrations } from "./schema/index.ts";

const MIGRATION_ID = "061_project_mandatory_takeover";

describe("project mandatory takeover migration", () => {
  test("enables and binds every existing project idempotently", () => {
    const db = new Database(":memory:");
    try {
      const index = migrations.findIndex((migration) => migration.id === MIGRATION_ID);
      expect(index).toBeGreaterThan(0);
      runMigrations(db, migrations.slice(0, index));
      db.run(`insert into pi_agents (
        id, name, provider, model_provider, model_id, thinking_level, cwd_policy,
        tools_json, instructions, enabled, created_at, updated_at
      ) values (
        'runner-default', 'Xuanwu Supervisor', 'pi-sdk', 'openai', 'gpt-5.4', 'medium', 'project',
        '[]', '', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
      )`);
      db.run(`insert into projects (id, name, cwd, auto_run, created_at, updated_at) values
        ('managed', 'Managed', '/tmp/managed', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
        ('legacy', 'Legacy', '/tmp/legacy', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
      db.run(`insert into project_pi_settings (project_id, created_at, updated_at)
        values ('managed', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
      runMigrations(db, migrations);
      runMigrations(db, migrations);

      expect(db.query("select id, auto_run from projects order by id").all()).toEqual([
        { auto_run: 1, id: "legacy" },
        { auto_run: 1, id: "managed" }
      ]);
      expect(db.query("select project_id from project_pi_settings order by project_id").all()).toEqual([
        { project_id: "legacy" },
        { project_id: "managed" }
      ]);
      expect(db.query("select enabled from pi_agents where id='runner-default'").get()).toEqual({ enabled: 1 });
    } finally {
      db.close();
    }
  });
});
