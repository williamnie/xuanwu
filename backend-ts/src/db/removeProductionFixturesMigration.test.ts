import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runMigrations } from "./migrations.ts";
import { migrations } from "./schema/index.ts";

const roots: string[] = [];
const MIGRATION_ID = "051_remove_production_fixtures";

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
});

describe("production fixture removal migration", () => {
  test("moves live fixture-domain references to canonical skills and preserves legacy run audit", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-remove-production-fixtures-"));
    roots.push(root);
    const path = join(root, "runner.db");
    await mkdir(dirname(path), { recursive: true });
    const db = new Database(path, { strict: true });
    try {
      const index = migrations.findIndex((migration) => migration.id === MIGRATION_ID);
      runMigrations(db, migrations.slice(0, index));
      seedLegacyRecords(db);

      runMigrations(db, migrations);
      runMigrations(db, migrations);

      const automation = db.query<{ steps_json: string }, []>("select steps_json from pi_automations").get();
      expect(JSON.parse(automation?.steps_json ?? "[]")).toEqual([
        { idempotency_key: "domain", skill_id: "pi-domain-proposal", type: "domain_skill" },
        { idempotency_key: "intake", skill_id: "fixture-domain", type: "intake" }
      ]);
      expect(db.query("select scope_id from pi_memory_items where id='legacy-skill-memory'").get())
        .toEqual({ scope_id: "pi-domain-proposal" });
      expect(db.query("select count(*) as count from pi_action_events where event_type='attention_inbox.domain_skill_requested'").get())
        .toEqual({ count: 1 });

      const migrated = db.query<{ actor: string; payload_json: string }, []>(
        "select actor, payload_json from pi_action_events where event_type='skill_runtime.completed'"
      ).all();
      expect(migrated).toHaveLength(1);
      expect(migrated[0]?.actor).toBe("migration");
      expect(JSON.parse(migrated[0]?.payload_json ?? "{}")).toMatchObject({
        action_count: 1,
        contract: "xw.skill-run.v1",
        item_id: 42,
        kind: "domain",
        migration_source_event_id: 1,
        skill_id: "legacy-domain-proposal",
        status: "succeeded"
      });
      expect(db.query("select id from schema_migrations where id=?").get(MIGRATION_ID)).toEqual({ id: MIGRATION_ID });
    } finally {
      db.close();
    }
  });
});

function seedLegacyRecords(db: Database): void {
  const now = "2026-07-18T00:00:00.000Z";
  db.run(
    `insert into pi_automations
      (name, trigger_type, steps_json, created_at, updated_at)
     values ('legacy domain automation', 'manual', ?, ?, ?)`,
    [JSON.stringify([
      { idempotency_key: "domain", skill_id: "fixture-domain", type: "domain_skill" },
      { idempotency_key: "intake", skill_id: "fixture-domain", type: "intake" }
    ]), now, now]
  );
  db.run(
    `insert into pi_memory_items
      (id, scope, scope_id, kind, content, created_at, updated_at)
     values ('legacy-skill-memory', 'skill', 'fixture-domain', 'memory', 'retain me', ?, ?)`,
    [now, now]
  );
  db.run(
    `insert into pi_action_events
      (action_id, event_type, payload_json, created_at)
     values ('legacy-domain-action', 'attention_inbox.domain_skill_requested', ?, ?)`,
    [JSON.stringify({ action_count: 1, item_id: 42, primary_intent: "bug_report", skill_id: "fixture-domain" }), now]
  );
}
