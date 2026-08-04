import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDatabase, type RunnerDatabase } from "./database.ts";
import { runMigrations } from "./migrations.ts";
import { migrations } from "./schema/index.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI delegation migration", () => {
  test("adds delegation envelope columns when migrating an existing runtime database", async () => {
    const root = await tempPath("xuanwu-bun-delegation-migrate-");
    const stateDir = join(root, "state");
    await createLegacyDelegationDatabase(join(stateDir, "runner.db"));

    const migrated = await openDatabase({ stateDir });
    try {
      expect(columnNames(migrated, "pi_delegations")).toEqual(expect.arrayContaining([
        "allowed_actions_json",
        "allowed_skill_intents_json",
        "audit_source",
        "expires_at",
        "forbidden_actions_json",
        "scope_json",
        "starts_at"
      ]));
      expect(migrated.sqlite.query("select title from issues where project_id='demo'").get())
        .toEqual({ title: "Legacy issue" });
      expect(migrationRow(migrated)).toEqual({ id: "012_pi_delegation_envelope" });
      expect(legacyDelegationRow(migrated)).toEqual({
        allowed_actions_json: "[]",
        allowed_skill_intents_json: "[]",
        audit_source: "",
        authorization_json: "{\"mode\":\"delegated\"}",
        expires_at: "",
        forbidden_actions_json: "[]",
        id: "legacy-delegation",
        scope_json: "{}",
        starts_at: ""
      });
    } finally {
      migrated.close();
    }
  });
});

async function tempPath(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(path);
  return path;
}

async function createLegacyDelegationDatabase(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    runMigrations(db, migrations.slice(0, delegationEnvelopeIndex()));
    db.run(
      "insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)",
      ["demo", "Demo", "/tmp/demo", "2026-06-03T09:00:00Z", "2026-06-03T09:00:00Z"]
    );
    db.run(
      "insert into issues (project_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?)",
      ["demo", "Legacy issue", "todo", "2026-06-03T09:00:00Z", "2026-06-03T09:00:00Z"]
    );
    db.run(`
      insert into pi_delegations
        (id, project_id, title, status, intent_json, authorization_json,
          next_heartbeat_at, last_heartbeat_at, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      "legacy-delegation", "demo", "Legacy window", "active", "{}",
      "{\"mode\":\"delegated\"}", "2026-06-03T21:00:00Z", "",
      "2026-06-03T09:00:00Z", "2026-06-03T09:00:00Z"
    ]);
  } finally {
    db.close();
  }
}

function delegationEnvelopeIndex(): number {
  const index = migrations.findIndex((migration) => migration.id === "012_pi_delegation_envelope");
  if (index < 0) throw new Error("delegation envelope migration missing");
  return index;
}

function columnNames(connection: RunnerDatabase, table: string): string[] {
  return connection.sqlite.query(`pragma table_info(${table})`).all()
    .map((row) => (row as { name: string }).name);
}

function legacyDelegationRow(connection: RunnerDatabase): unknown {
  return connection.sqlite.query(`
    select id, authorization_json, scope_json, starts_at, expires_at,
      allowed_actions_json, forbidden_actions_json, allowed_skill_intents_json, audit_source
    from pi_delegations where id='legacy-delegation'
  `).get();
}

function migrationRow(connection: RunnerDatabase): unknown {
  return connection.sqlite.query("select id from schema_migrations where id='012_pi_delegation_envelope'").get();
}
