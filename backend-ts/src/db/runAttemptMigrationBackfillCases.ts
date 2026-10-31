import { expect, test } from "bun:test";

import { readFileSync } from "node:fs";

import { join, resolve } from "node:path";
import { openDatabase } from "./database.ts";
import { runMigrations } from "./migrations.ts";

import {
  trackDatabase,
  NOW,
  tempPath,
  createPreRunAttemptDatabase,
  insertProject,
  insertIssue,
  insertLegacyRun,
  tableNames,
  generatedColumnNames,
  indexNames,
  migrationCount,
  mappingCounts,
  orphanCounts,
  queryPlan
} from "./runAttemptMigrationTestFixtures.ts";

export function registerRunAttemptMigrationBackfillCases() {
  test("creates additive Run identity, Attempt storage, and indexes on an empty database", async () => {
    const connection = await openDatabase({ stateDir: await tempPath("run-attempt-empty-") }).then(trackDatabase);
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
  });

  test("backfills a historical database with stable IDs and quarantines unknown legacy status", async () => {
    const stateDir = await tempPath("run-attempt-upgrade-");
    await createPreRunAttemptDatabase(join(stateDir, "runner.db"));

    const migrated = await openDatabase({ stateDir }).then(trackDatabase);
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
  });

  test("keeps the legacy issue_runs and agent_sessions writers compatible", async () => {
    const connection = await openDatabase({ stateDir: await tempPath("run-attempt-legacy-writer-") }).then(trackDatabase);
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
  });

  test("enforces unique mappings, rejects orphan Attempts, and cascades legacy deletion", async () => {
    const connection = await openDatabase({ stateDir: await tempPath("run-attempt-constraints-") }).then(trackDatabase);
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
  });

  test("uses the declared indexes and remains idempotent", async () => {
    const connection = await openDatabase({ stateDir: await tempPath("run-attempt-query-plan-") }).then(trackDatabase);
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
}
