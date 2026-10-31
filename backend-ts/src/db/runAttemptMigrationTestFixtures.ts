import { afterEach } from "bun:test";
import { Database } from "bun:sqlite";

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type RunnerDatabase } from "./database.ts";
import { runMigrations } from "./migrations.ts";
import { migrations } from "./schema/index.ts";
import { useDatabaseCleanup } from "../testing/harness.ts";

export const trackDatabase = useDatabaseCleanup();

export const MIGRATION_ID = "042_run_attempt_relations";

export const NOW = "2026-07-16T00:00:00.000Z";

export const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

export async function tempPath(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(path);
  return path;
}

export async function createPreRunAttemptDatabase(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const db = new Database(path, { strict: true });
  try {
    db.run("pragma foreign_keys = on");
    runMigrations(db, migrations.slice(0, runAttemptMigrationIndex()));
    db.run(
      "insert into projects (id, name, cwd, created_at, updated_at) values ('demo', 'Demo', '/tmp/demo', ?, ?)",
      [NOW, NOW]
    );
    db.run(`
      insert into issues (project_id, title, status, created_at, updated_at)
      values ('demo', 'One', 'done', ?, ?), ('demo', 'Two', 'in_progress', ?, ?)
    `, [NOW, NOW, NOW, NOW]);
    db.run(`
      insert into works (
        id, project_id, type, title, goal, status, acceptance_json,
        provenance_json, workflow_ref, created_at, updated_at
      ) values (
        'xw:work:issues:1', 'demo', 'engineering_task', 'One', 'One', 'done',
        '{}', '{}', 'agent-execution-contract', ?, ?
      )
    `, [NOW, NOW]);
    db.run(`
      insert into agent_sessions (
        session_key, provider, provider_session_id, issue_id, created_at, updated_at
      ) values ('codex:thread-one', 'codex', 'thread-one', 1, ?, ?)
    `, [NOW, NOW]);
    insertHistoricalRun(db, "legacy-run-1", 1, 1, "done", "thread-one", "turn-one", NOW);
    insertHistoricalRun(db, "legacy-run-2", 1, 2, "auto_retry", "missing-session", "turn-two", NOW);
    insertHistoricalRun(db, "legacy-run-3", 2, 1, "in_progress", "", "", "");
  } finally {
    db.close();
  }
}

export function runAttemptMigrationIndex(): number {
  const index = migrations.findIndex((migration) => migration.id === MIGRATION_ID);
  if (index < 0) throw new Error("Run/Attempt relation migration missing");
  return index;
}

export function insertHistoricalRun(
  db: Database,
  id: string,
  issueID: number,
  attempt: number,
  status: string,
  sessionID: string,
  turnID: string,
  endedAt: string
): void {
  db.run(`
    insert into issue_runs (
      id, issue_id, attempt, status, provider, provider_session_id,
      provider_turn_id, started_at, ended_at, exit_reason
    ) values (?, ?, ?, ?, 'codex', ?, ?, ?, ?, ?)
  `, [id, issueID, attempt, status, sessionID, turnID, NOW, endedAt, endedAt === "" ? "" : "completed"]);
}

export function insertProject(connection: RunnerDatabase, id: string): void {
  connection.sqlite.run(
    "insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)",
    [id, id, `/tmp/${id}`, NOW, NOW]
  );
}

export function insertIssue(connection: RunnerDatabase, projectID: string): number {
  connection.sqlite.run(`
    insert into issues (project_id, title, status, created_at, updated_at)
    values (?, 'Run migration', 'in_progress', ?, ?)
  `, [projectID, NOW, NOW]);
  const row = connection.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing Issue id");
  return row.id;
}

export function insertLegacyRun(
  connection: RunnerDatabase,
  id: string,
  issueID: number,
  attempt: number,
  status: string
): void {
  connection.sqlite.run(`
    insert into issue_runs (id, issue_id, attempt, status, provider, started_at)
    values (?, ?, ?, ?, 'codex', ?)
  `, [id, issueID, attempt, status, NOW]);
}

export function tableNames(connection: RunnerDatabase): string[] {
  return connection.sqlite.query("select name from sqlite_master where type='table'").all()
    .map((row) => (row as { name: string }).name);
}

export function generatedColumnNames(connection: RunnerDatabase, table: string): string[] {
  return connection.sqlite.query(`pragma table_xinfo(${table})`).all()
    .filter((row) => (row as { hidden: number }).hidden !== 0)
    .map((row) => (row as { name: string }).name);
}

export function indexNames(connection: RunnerDatabase, table: string): string[] {
  return connection.sqlite.query(`pragma index_list(${table})`).all()
    .map((row) => (row as { name: string }).name);
}

export function migrationCount(connection: RunnerDatabase): unknown {
  return connection.sqlite.query("select count(*) as count from schema_migrations where id=?").get(MIGRATION_ID);
}

export function mappingCounts(connection: RunnerDatabase): unknown {
  return connection.sqlite.query(`
    select
      (select count(*) from issue_runs) as issue_runs,
      (select count(distinct run_id) from issue_runs) as run_ids,
      (select count(*) from run_attempts) as attempts
  `).get();
}

export function orphanCounts(connection: RunnerDatabase): unknown {
  return connection.sqlite.query(`
    select
      (select count(*) from run_attempts attempt
        left join issue_runs run on run.run_id=attempt.run_id and run.id=attempt.issue_run_id
        where run.id is null) as attempt_orphans,
      (select count(*) from run_attempts attempt
        left join agent_sessions session on session.session_key=attempt.agent_session_key
        where attempt.agent_session_key is not null and session.session_key is null) as agent_session_orphans,
      (select count(*) from issue_runs run
        left join issues issue on issue.id=run.issue_id
        where issue.id is null or run.work_id <> 'xw:work:issues:' || issue.id) as work_identity_orphans
  `).get();
}

export function queryPlan(connection: RunnerDatabase, sql: string): string {
  return connection.sqlite.query(`explain query plan ${sql}`).all()
    .map((row) => (row as { detail: string }).detail)
    .join("\n");
}
