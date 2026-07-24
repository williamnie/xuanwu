import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runMigrations } from "./migrations.ts";
import { migrations } from "./schema/index.ts";

const MIGRATION_ID = "058_drop_issue_templates";

describe("Issue template removal migration", () => {
  test("drops template storage while preserving the Issue", () => {
    const db = new Database(":memory:");
    try {
      const index = migrations.findIndex((migration) => migration.id === MIGRATION_ID);
      expect(index).toBeGreaterThan(0);
      runMigrations(db, migrations.slice(0, index));
      db.run(`
        create table if not exists issue_templates (
          id text primary key,
          name text not null,
          content text not null,
          is_default integer not null default 0,
          created_at text not null,
          updated_at text not null
        )
      `);
      addColumnIfMissing(db, "template_id", "text not null default ''");
      addColumnIfMissing(db, "prompt_template", "text not null default ''");
      db.run(`insert into projects (id, name, cwd, created_at, updated_at)
        values ('demo', 'Demo', '/tmp/demo', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
      db.run(`insert into issue_templates (id, name, content, is_default, created_at, updated_at)
        values ('default', 'Default', '{{issue.description}}', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
      db.run(`insert into issues (
        project_id, title, description, status, template_id, prompt_template, created_at, updated_at
      ) values (
        'demo', 'Keep me', 'Preserve the Issue body', 'done', 'default', '{{issue.description}}',
        '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
      )`);

      runMigrations(db, migrations);
      runMigrations(db, migrations);

      expect(tableNames(db)).not.toContain("issue_templates");
      expect(columnNames(db, "issues")).not.toContain("template_id");
      expect(columnNames(db, "issues")).not.toContain("prompt_template");
      expect(db.query("select title, description, status from issues").get()).toEqual({
        title: "Keep me",
        description: "Preserve the Issue body",
        status: "done"
      });
      expect(db.query("select id from schema_migrations where id=?").get(MIGRATION_ID)).toEqual({ id: MIGRATION_ID });
    } finally {
      db.close();
    }
  });
});

function addColumnIfMissing(db: Database, column: string, definition: string): void {
  if (columnNames(db, "issues").includes(column)) return;
  db.run(`alter table issues add column ${column} ${definition}`);
}

function columnNames(db: Database, table: string): string[] {
  return db.query<{ name: string }, []>(`pragma table_info(${table})`).all().map((row) => row.name);
}

function tableNames(db: Database): string[] {
  return db.query<{ name: string }, []>(
    "select name from sqlite_schema where type='table' order by name"
  ).all().map((row) => row.name);
}
