import { expect } from "bun:test";
import { Database } from "bun:sqlite";

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "./database.ts";
import { runMigrations } from "./migrations.ts";
import { migrations } from "./schema/index.ts";

import { FIXTURE_TIME, useDatabaseCleanup, useTempDirs } from "../testing/harness.ts";

export const trackDatabase = useDatabaseCleanup();

export const tempDir = useTempDirs("xuanwu-bun-db-");

export const SUPERVISOR_INSTRUCTIONS = "先回答用户真正关心的问题，再补必要理由；说人话，避免不必要的内部术语和流程播报。";

export async function newStateDir(): Promise<string> {
  return join(await tempDir(), "state");
}

export function openRuntime(stateDir: string): Promise<RunnerDatabase> {
  return openDatabase({ stateDir }).then(trackDatabase);
}

export async function reopenAfter(mutate: (raw: Database) => void): Promise<RunnerDatabase> {
  const stateDir = await newStateDir();
  (await openDatabase({ stateDir })).close();
  withFileDatabase(join(stateDir, "runner.db"), mutate);
  return openRuntime(stateDir);
}

export async function legacyStateDir(boundary: string, seed: (legacy: Database) => void = () => {}): Promise<string> {
  const stateDir = await newStateDir();
  await mkdir(stateDir, { recursive: true });
  withFileDatabase(join(stateDir, "runner.db"), (legacy) => {
    runMigrations(legacy, migrationsBefore(boundary));
    seed(legacy);
  });
  return stateDir;
}

export function withFileDatabase(path: string, use: (db: Database) => unknown): void {
  const db = new Database(path);
  try {
    use(db);
  } finally {
    db.close();
  }
}

export function withMemoryDatabase(use: (db: Database) => void): void {
  withFileDatabase(":memory:", use);
}

export function insertLegacyAgentReferences(raw: Database, projectID: string, conversationID: string, agentID: string): void {
  raw.run("insert into project_pi_settings (project_id, created_at, updated_at) values (?, ?, ?)", [projectID, FIXTURE_TIME, FIXTURE_TIME]);
  raw.run("insert into pi_conversations (id, pi_agent_id, created_at, updated_at) values (?, ?, ?, ?)", [conversationID, agentID, FIXTURE_TIME, FIXTURE_TIME]);
}

export function expectLegacyAgentReferencesMoved(db: RunnerDatabase, projectID: string, conversationID: string): void {
  expect(db.sqlite.query("select project_id from project_pi_settings where project_id=?").get(projectID)).toEqual({ project_id: projectID });
  expect(db.sqlite.query("select pi_agent_id from pi_conversations where id=?").get(conversationID)).toEqual({ pi_agent_id: "runner-default" });
}

export function migrationCount(db: RunnerDatabase, id: string): number {
  return db.sqlite.query<{ count: number }, [string]>("select count(*) as count from schema_migrations where id=?").get(id)?.count ?? 0;
}

export function migrationsBefore(id: string): typeof migrations {
  const index = migrations.findIndex((migration) => migration.id === id);
  if (index < 0) throw new Error(`Unknown migration fixture boundary: ${id}`);
  return migrations.slice(0, index);
}

export function tableNames(connection: RunnerDatabase): string[] {
  return connection.sqlite.query<{ name: string }, []>("select name from sqlite_master where type='table' order by name asc")
    .all().map((row) => row.name);
}

export function columnNames(connection: RunnerDatabase, table: string): string[] {
  return connection.sqlite.query<{ name: string }, []>(`pragma table_info(${table})`).all().map((row) => row.name);
}

export function generatedColumnNames(connection: RunnerDatabase, table: string): string[] {
  return connection.sqlite.query<{ hidden: number; name: string }, []>(`pragma table_xinfo(${table})`).all()
    .filter((row) => row.hidden !== 0).map((row) => row.name);
}

export function columnDefaults(connection: RunnerDatabase, table: string): Record<string, string | null> {
  return Object.fromEntries(connection.sqlite.query<{ dflt_value: string | null; name: string }, []>(`pragma table_info(${table})`)
    .all().map((column) => [column.name, column.dflt_value]));
}

export function indexNames(connection: RunnerDatabase, table: string): string[] {
  return connection.sqlite.query<{ name: string }, []>(`pragma index_list(${table})`).all().map((row) => row.name);
}

export function indexSQL(connection: RunnerDatabase, index: string): string {
  return connection.sqlite.query<{ sql: string }, [string]>("select sql from sqlite_master where type='index' and name=?").get(index)?.sql ?? "";
}



export { TABLES, MIGRATIONS, COLUMNS, INDEXES, DEFAULTS } from "./databaseTestSchema.ts";
