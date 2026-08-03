import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { openDatabase, type RunnerDatabase } from "./database.ts";
import { runMigrations } from "./migrations.ts";
import { migrations } from "./schema/index.ts";

const MIGRATION_ID = "042_run_attempt_relations";
const NOW = "2026-07-16T00:00:00.000Z";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Run/Attempt relation migration", () => {
  test("creates additive Run identity, Attempt storage, and indexes on an empty database", async () => {
    const connection = await openDatabase({ stateDir: await tempPath("run-attempt-empty-") });
    try {
      expect(generatedColumnNames(connection, "issue_runs")).toEqual(expect.arrayContaining([
        "run_id", "run_sequence", "work_id"
      ]));
      expect(tableNames(connection)).toContain("run_attempts");
      expect(indexNames(connection, "issue_runs")).toEqual(expect.arrayContaining([
        "ux_issue_runs_run_id", "ux_issue_runs_run_legacy", "ux_issue_runs_work_sequence"
      ]));
      expect(indexNames(connection, "run_attempts")).toEqual(expect.arrayContaining([
        "idx_run_attempts_agent_session",
        "idx_run_attempts_provider_session",
        "ux_run_attempts_provider_invocation",
        "ux_run_attempts_run_sequence"
      ]));
      expect(migrationCount(connection)).toEqual({ count: 1 });
    } finally {
      connection.close();
    }
  });

  test("backfills a historical database with stable IDs and quarantines unknown legacy status", async () => {
    const stateDir = await tempPath("run-attempt-upgrade-");
    await createPreRunAttemptDatabase(join(stateDir, "runner.db"));

    const migrated = await openDatabase({ stateDir });
    try {
      expect(migrated.sqlite.query(`
        select id, run_id, work_id, run_sequence
        from issue_runs order by issue_id, attempt
      `).all()).toEqual([
        {
          id: "legacy-run-1",
          run_id: "xw:run:issue_runs:legacy-run-1",
          run_sequence: 1,
          work_id: "xw:work:issues:1"
        },
        {
          id: "legacy-run-2",
          run_id: "xw:run:issue_runs:legacy-run-2",
          run_sequence: 2,
          work_id: "xw:work:issues:1"
        },
        {
          id: "legacy-run-3",
          run_id: "xw:run:issue_runs:legacy-run-3",
          run_sequence: 1,
          work_id: "xw:work:issues:2"
        }
      ]);
      expect(migrated.sqlite.query(`
        select attempt_id, issue_run_id, status, legacy_status, mapping_error, agent_session_key
        from run_attempts order by issue_run_id
      `).all()).toEqual([
        {
          agent_session_key: "codex:thread-one",
          attempt_id: "xw:run:issue_runs:legacy-run-1~attempt:1",
          issue_run_id: "legacy-run-1",
          legacy_status: "succeeded",
          mapping_error: "",
          status: "succeeded"
        },
        {
          agent_session_key: null,
          attempt_id: "xw:run:issue_runs:legacy-run-2~attempt:1",
          issue_run_id: "legacy-run-2",
          legacy_status: "auto_retry",
          mapping_error: "unsupported issue_run status: auto_retry",
          status: null
        },
        {
          agent_session_key: null,
          attempt_id: "xw:run:issue_runs:legacy-run-3~attempt:1",
          issue_run_id: "legacy-run-3",
          legacy_status: "in_progress",
          mapping_error: "",
          status: "running"
        }
      ]);
      expect(mappingCounts(migrated)).toEqual({ attempts: 3, issue_runs: 3, run_ids: 3 });
      expect(orphanCounts(migrated)).toEqual({
        agent_session_orphans: 0,
        attempt_orphans: 0,
        work_identity_orphans: 0
      });
      expect(migrated.sqlite.query("pragma foreign_key_check").all()).toEqual([]);
    } finally {
      migrated.close();
    }
  });

  test("keeps the legacy issue_runs and agent_sessions writers compatible", async () => {
    const connection = await openDatabase({ stateDir: await tempPath("run-attempt-legacy-writer-") });
    try {
      insertProject(connection, "demo");
      const issueID = insertIssue(connection, "demo");
      connection.sqlite.run(`
        insert into issue_runs (id, issue_id, attempt, status, provider, started_at)
        values ('legacy-writer-run', ?, 1, 'in_progress', 'codex', ?)
      `, [issueID, NOW]);
      connection.sqlite.run(`
        update issue_runs set status='done', ended_at=?, exit_reason='completed',
          provider_session_id='thread-late', provider_turn_id='turn-late'
        where id='legacy-writer-run'
      `, [NOW]);
      connection.sqlite.run(`
        insert into agent_sessions (
          session_key, provider, provider_session_id, issue_id, created_at, updated_at
        ) values ('codex:thread-late', 'codex', 'thread-late', ?, ?, ?)
      `, [issueID, NOW, NOW]);

      expect(connection.sqlite.query(`
        select run_id, work_id, run_sequence from issue_runs where id='legacy-writer-run'
      `).get()).toEqual({
        run_id: "xw:run:issue_runs:legacy-writer-run",
        run_sequence: 1,
        work_id: `xw:work:issues:${issueID}`
      });
      expect(connection.sqlite.query(`
        select status, legacy_status, provider_session_id, provider_turn_id,
          agent_session_key, terminal_reason, terminal_source_ref
        from run_attempts where issue_run_id='legacy-writer-run'
      `).get()).toEqual({
        agent_session_key: "codex:thread-late",
        legacy_status: "done",
        provider_session_id: "thread-late",
        provider_turn_id: "turn-late",
        status: null,
        terminal_reason: "",
        terminal_source_ref: ""
      });
    } finally {
      connection.close();
    }
  });

  test("enforces unique mappings, rejects orphan Attempts, and cascades legacy deletion", async () => {
    const connection = await openDatabase({ stateDir: await tempPath("run-attempt-constraints-") });
    try {
      insertProject(connection, "demo");
      const issueID = insertIssue(connection, "demo");
      insertLegacyRun(connection, "run-one", issueID, 1, "in_progress");

      expect(() => insertLegacyRun(connection, "run-duplicate-sequence", issueID, 1, "in_progress"))
        .toThrow();
      expect(() => connection.sqlite.run(`
        insert into run_attempts (
          attempt_id, run_id, issue_run_id, sequence, kind, status, provider,
          provider_invocation_ref, created_at, updated_at
        ) values (
          'xw:run:issue_runs:missing~attempt:1', 'xw:run:issue_runs:missing',
          'missing', 1, 'initial', 'running', 'codex', 'missing', ?, ?
        )
      `, [NOW, NOW])).toThrow();
      expect(() => connection.sqlite.run(`
        insert into run_attempts (
          attempt_id, run_id, issue_run_id, sequence, kind, status, provider,
          provider_invocation_ref, created_at, updated_at
        ) values (
          'wrong-attempt-id', 'xw:run:issue_runs:run-one', 'run-one',
          2, 'resume', 'running', 'codex', 'resume-two', ?, ?
        )
      `, [NOW, NOW])).toThrow();

      connection.sqlite.run("delete from issue_runs where id='run-one'");
      expect(connection.sqlite.query("select count(*) as count from run_attempts").get()).toEqual({ count: 0 });
    } finally {
      connection.close();
    }
  });

  test("uses the declared indexes and remains idempotent", async () => {
    const connection = await openDatabase({ stateDir: await tempPath("run-attempt-query-plan-") });
    try {
      runMigrations(connection.sqlite);
      expect(migrationCount(connection)).toEqual({ count: 1 });
      expect(queryPlan(connection, `
        select * from issue_runs
        where work_id='xw:work:issues:1'
        order by run_sequence
      `)).toContain("ux_issue_runs_work_sequence");
      expect(queryPlan(connection, `
        select * from run_attempts
        where agent_session_key='codex:thread-one'
        order by run_id, sequence
      `)).toContain("idx_run_attempts_agent_session");
      expect(queryPlan(connection, `
        select * from run_attempts
        where provider='codex' and provider_session_id='thread-one'
      `)).toContain("idx_run_attempts_provider_session");
    } finally {
      connection.close();
    }
  });

  test("documents authority, legacy policy, compatibility window, and rollback", () => {
    const note = readFileSync(
      resolve(import.meta.dir, "../../../docs/architecture/xuanwu/0021-run-attempt-relations.md"),
      "utf8"
    );
    expect(note).toContain("`issue_runs` 仍是唯一 Run authority");
    expect(note).toContain("`agent_sessions` 仍是 observation / drill-down");
    expect(note).toContain("未知 legacy status 必须保留原值并 fail closed");
    expect(note).toContain("双写窗口为 0");
    expect(note).toContain("最多一个正式 release");
    expect(note).toContain("Schema rollback note");
    expect(note).toContain("不得删除 `issue_runs`");
  });
});

async function tempPath(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(path);
  return path;
}

async function createPreRunAttemptDatabase(path: string): Promise<void> {
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

function runAttemptMigrationIndex(): number {
  const index = migrations.findIndex((migration) => migration.id === MIGRATION_ID);
  if (index < 0) throw new Error("Run/Attempt relation migration missing");
  return index;
}

function insertHistoricalRun(
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

function insertProject(connection: RunnerDatabase, id: string): void {
  connection.sqlite.run(
    "insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)",
    [id, id, `/tmp/${id}`, NOW, NOW]
  );
}

function insertIssue(connection: RunnerDatabase, projectID: string): number {
  connection.sqlite.run(`
    insert into issues (project_id, title, status, created_at, updated_at)
    values (?, 'Run migration', 'in_progress', ?, ?)
  `, [projectID, NOW, NOW]);
  const row = connection.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing Issue id");
  return row.id;
}

function insertLegacyRun(
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

function tableNames(connection: RunnerDatabase): string[] {
  return connection.sqlite.query("select name from sqlite_master where type='table'").all()
    .map((row) => (row as { name: string }).name);
}

function generatedColumnNames(connection: RunnerDatabase, table: string): string[] {
  return connection.sqlite.query(`pragma table_xinfo(${table})`).all()
    .filter((row) => (row as { hidden: number }).hidden !== 0)
    .map((row) => (row as { name: string }).name);
}

function indexNames(connection: RunnerDatabase, table: string): string[] {
  return connection.sqlite.query(`pragma index_list(${table})`).all()
    .map((row) => (row as { name: string }).name);
}

function migrationCount(connection: RunnerDatabase): unknown {
  return connection.sqlite.query("select count(*) as count from schema_migrations where id=?").get(MIGRATION_ID);
}

function mappingCounts(connection: RunnerDatabase): unknown {
  return connection.sqlite.query(`
    select
      (select count(*) from issue_runs) as issue_runs,
      (select count(distinct run_id) from issue_runs) as run_ids,
      (select count(*) from run_attempts) as attempts
  `).get();
}

function orphanCounts(connection: RunnerDatabase): unknown {
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

function queryPlan(connection: RunnerDatabase, sql: string): string {
  return connection.sqlite.query(`explain query plan ${sql}`).all()
    .map((row) => (row as { detail: string }).detail)
    .join("\n");
}
