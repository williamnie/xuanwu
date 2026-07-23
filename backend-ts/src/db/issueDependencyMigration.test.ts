import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "./migrations.ts";
import { migrations } from "./schema/index.ts";

const MIGRATION_ID = "057_issue_dependency_and_run_git_baseline";
const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
});

describe("Issue dependency and Run Git baseline migration", () => {
  test("backfills legacy Markdown dependencies and repairs deferred Guardian evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-issue-dependency-migration-"));
    roots.push(root);
    const db = new Database(join(root, "runner.db"), { strict: true });
    try {
      const index = migrations.findIndex((migration) => migration.id === MIGRATION_ID);
      expect(index).toBeGreaterThan(0);
      runMigrations(db, migrations.slice(0, index));
      seedLegacyState(db);

      runMigrations(db, migrations);
      runMigrations(db, migrations);

      expect(db.query(
        "select dependency_issue_ids_json, dependency_declaration_error from issues where id=775"
      ).get()).toEqual({
        dependency_declaration_error: "",
        dependency_issue_ids_json: "[774]"
      });
      expect(db.query(
        "select source_work_id, target_work_id, kind from work_relations where relation_id='issue-dependency:775:774'"
      ).get()).toEqual({
        kind: "depends_on",
        source_work_id: "xw:work:issues:775",
        target_work_id: "xw:work:issues:774"
      });
      expect(db.query("select id from works where id='xw:work:issues:777'").get()).toBeNull();
      expect(db.query("select git_base_revision from issue_runs where id='issue-774-attempt-1'").get())
        .toEqual({ git_base_revision: "" });
      const evidence = db.query<{ evidence_json: string }, []>(
        "select evidence_json from pi_guardian_decisions where id='stuck-deferred'"
      ).get()?.evidence_json ?? "[]";
      expect(JSON.parse(evidence)).toContainEqual(expect.objectContaining({
        guardian_decision_rate_limit: expect.objectContaining({
          retry_at: "2026-07-23T01:00:00Z",
          scope: "migration_recovered"
        })
      }));
      expect(db.query("select id from schema_migrations where id=?").get(MIGRATION_ID))
        .toEqual({ id: MIGRATION_ID });
    } finally {
      db.close();
    }
  });
});

function seedLegacyState(db: Database): void {
  const now = "2026-07-23T00:00:00Z";
  db.run(`insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
    values ('demo', 'Demo', '/tmp/demo', 'codex', 1, ?, ?)`, [now, now]);
  db.run(`insert into issues (id, project_id, title, description, status, created_at, updated_at)
    values (774, 'demo', 'upstream', '', 'failed', ?, ?)`, [now, now]);
  db.run(`insert into issues (id, project_id, title, description, status, created_at, updated_at)
    values (775, 'demo', 'downstream', '## 依赖\n\n- Issue #774', 'todo', ?, ?)`, [now, now]);
  db.run(`insert into issues (id, project_id, title, description, status, created_at, updated_at)
    values (777, 'demo', 'independent', '', 'todo', ?, ?)`, [now, now]);
  db.run(`insert into issue_runs
    (id, issue_id, attempt, status, provider, started_at, ended_at)
    values ('issue-774-attempt-1', 774, 1, 'failed', 'codex', ?, ?)`, [now, now]);
  db.run(`insert into pi_guardian_decisions (
    id, idempotency_key, decision_kind, project_id, issue_id, decision,
    evidence_json, state, cooldown_until, created_at, updated_at
  ) values (
    'stuck-deferred', 'stuck-deferred', 'recovery', 'demo', 774, 'needs_user',
    '[{"guardian_decision_merge":{"merge_key":"recovery:demo:774:failed:actionable"}}]',
    'deferred', '2026-07-23T01:00:00Z', ?, ?
  )`, [now, now]);
}
