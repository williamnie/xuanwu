import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "./database.ts";

const tempRoots: string[] = [];

async function tempPath(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(path);
  return path;
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun SQLite database connection", () => {
  test("creates the state directory and default runner database", async () => {
    const root = await tempPath("codex-runner-db-");
    const stateDir = join(root, "state");
    const connection = await openDatabase({ stateDir });

    try {
      connection.sqlite.run("create table items (name text not null)");
      connection.sqlite.run("insert into items (name) values (?)", ["alpha"]);

      expect(connection.path).toBe(join(stateDir, "runner.db"));
      expect(existsSync(stateDir)).toBe(true);
      expect(existsSync(connection.path)).toBe(true);
      expect(connection.sqlite.query("select name from items").get()).toEqual({ name: "alpha" });
    } finally {
      connection.close();
    }
  });

  test("runs the base schema migration on an empty runtime database", async () => {
    const root = await tempPath("codex-runner-bun-schema-");
    const connection = await openDatabase({ stateDir: join(root, "state") });

    try {
      expect(tableNames(connection)).toEqual([
        "agent_profiles",
        "agent_sessions",
        "app_preferences",
        "cron_tasks",
        "issue_events",
        "issue_runs",
        "issue_templates",
        "issues",
        "pi_action_events",
        "pi_actions",
        "pi_agents",
        "pi_conversations",
        "pi_memory_items",
        "project_holds",
        "project_pi_settings",
        "projects",
        "schema_migrations",
        "session_command_events",
        "session_turn_references",
        "sqlite_sequence",
        "uploads"
      ]);
      expect(columnNames(connection, "projects")).toContain("default_agent_profile_id");
      expect(columnNames(connection, "issues")).toContain("workflow_snapshot_json");
      expect(columnNames(connection, "issue_runs")).toContain("provider_session_id");
      expect(columnNames(connection, "issue_runs")).toContain("runtime_metadata_json");
      expect(connection.sqlite.query("select id from schema_migrations").all()).toEqual([
        { id: "001_base_schema" },
        { id: "002_agent_sessions_runtime" },
        { id: "003_pi_runtime" },
        { id: "004_safe_go_import_tables" },
        { id: "005_read_performance_indexes" },
        { id: "006_pi_action_gate_audit" }
      ]);
      expect(indexNames(connection, "issue_events")).toContain("idx_issue_events_issue_type");
      expect(columnNames(connection, "pi_actions")).toContain("gate_decision");
      expect(indexNames(connection, "pi_action_events")).toContain("idx_pi_action_events_action");
    } finally {
      connection.close();
    }
  });



  test("repairs schema drift when a migration row exists but tables are missing", async () => {
    const root = await tempPath("codex-runner-bun-schema-drift-");
    const stateDir = join(root, "state");
    const first = await openDatabase({ stateDir });
    first.close();

    const raw = new Database(join(stateDir, "runner.db"));
    try {
      raw.run("drop table project_holds");
      raw.run("drop table cron_tasks");
    } finally {
      raw.close();
    }

    const repaired = await openDatabase({ stateDir });
    try {
      expect(tableNames(repaired)).toContain("project_holds");
      expect(tableNames(repaired)).toContain("cron_tasks");
      expect(repaired.sqlite.query("select count(*) as count from schema_migrations where id='004_safe_go_import_tables'").get()).toEqual({ count: 1 });
    } finally {
      repaired.close();
    }
  });

  test("keeps migrations idempotent across repeated runtime opens", async () => {
    const root = await tempPath("codex-runner-bun-idempotent-");
    const stateDir = join(root, "state");
    const first = await openDatabase({ stateDir });
    first.close();

    const second = await openDatabase({ stateDir });

    try {
      expect(second.sqlite.query("select count(*) as count from schema_migrations").get()).toEqual({ count: 6 });
      expect(second.sqlite.query("select count(*) as count from projects").get()).toEqual({ count: 0 });
    } finally {
      second.close();
    }
  });

  test("opens explicit read-only import database without allowing writes", async () => {
    const root = await tempPath("codex-runner-bun-import-");
    const dataDir = join(root, "data");
    const importPath = join(dataDir, "runner.db");
    await mkdir(dataDir, { recursive: true });
    createFixtureDatabase(importPath);

    const connection = await openDatabase({ readonlyImportPath: importPath });

    try {
      expect(connection.readonly).toBe(true);
      expect(connection.sqlite.query("select name from items").get()).toEqual({ name: "fixture" });
      expect(() => connection.sqlite.run("insert into items (name) values ('write')")).toThrow();
    } finally {
      connection.close();
    }
  });

  test("runs callbacks inside a rollback-capable transaction", async () => {
    const root = await tempPath("codex-runner-bun-tx-");
    const connection = await openDatabase({ stateDir: join(root, "state") });

    try {
      connection.sqlite.run("create table items (name text not null)");
      const insertThenFail = failingInsertTransaction(connection);

      expect(() => insertThenFail("rolled-back")).toThrow("rollback fixture");
      expect(connection.sqlite.query("select count(*) as count from items").get()).toEqual({ count: 0 });
    } finally {
      connection.close();
    }
  });
});

function createFixtureDatabase(path: string): void {
  const db = new Database(path);
  try {
    db.run("create table items (name text not null)");
    db.run("insert into items (name) values ('fixture')");
  } finally {
    db.close();
  }
}

function failingInsertTransaction(connection: RunnerDatabase): (name: string) => void {
  return connection.transaction((name: string) => {
    connection.sqlite.run("insert into items (name) values (?)", [name]);
    throw new Error("rollback fixture");
  });
}

function tableNames(connection: RunnerDatabase): string[] {
  return connection.sqlite.query(`
    select name from sqlite_master
    where type='table'
    order by name asc
  `).all().map((row) => (row as { name: string }).name);
}

function columnNames(connection: RunnerDatabase, table: string): string[] {
  return connection.sqlite.query(`pragma table_info(${table})`).all()
    .map((row) => (row as { name: string }).name);
}

function indexNames(connection: RunnerDatabase, table: string): string[] {
  return connection.sqlite.query(`pragma index_list(${table})`).all()
    .map((row) => (row as { name: string }).name);
}
