import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { READONLY_BUSY_TIMEOUT_MS, WAL_AUTOCHECKPOINT_PAGES, openDatabase } from "./database.ts";
import { runMigrations } from "./migrations.ts";

import { telegramChannelRuntimeMigration } from "./schema/081_telegram_channel_runtime.ts";

import {
  trackDatabase,
  tempDir,
  newStateDir,
  openRuntime,
  reopenAfter,
  legacyStateDir,
  withFileDatabase,
  withMemoryDatabase,
  migrationCount,
  migrationsBefore,
  tableNames,
  columnNames,
  indexNames,
  MIGRATIONS
} from "./databaseTestFixtures.ts";

export function registerDatabaseSchemaRepairCases() {
  test("repairs older approval request tables after the migration row exists", async () => {
    const repaired = await reopenAfter((raw) => {
      raw.run("drop table pi_approval_requests");
      raw.run(`
        create table pi_approval_requests (
          approval_id text primary key,
          project_id text not null default '',
          issue_id integer not null default 0,
          provider text not null default '',
          thread_id text not null default '',
          turn_id text not null default '',
          request_type text not null default '',
          request_summary text not null default '',
          risk text not null default 'medium',
          status text not null default 'pending',
          approval_source text not null default '',
          provider_approval_id text not null default '',
          delivery_channel text not null default '',
          delivered_at text not null default '',
          resolved_decision text not null default '',
          resolved_scope text not null default '',
          resolved_at text not null default '',
          raw_payload_json text not null default '{}',
          created_at text not null,
          updated_at text not null
        )
      `);
      raw.run(`insert into pi_approval_requests
        (approval_id, project_id, issue_id, provider, thread_id, request_type, request_summary, created_at, updated_at)
        values ('approval-old', 'demo', 393, 'codex', 'thread-old', 'command', 'command=git status', ?, ?)`,
      ["2026-06-14T00:00:00Z", "2026-06-14T00:00:00Z"]);
    });

    expect(columnNames(repaired, "pi_approval_requests")).toEqual(expect.arrayContaining([
      "async_escalation_state", "decision", "delivery_state", "fast_decision", "fast_policy_latency_ms",
      "fast_policy_rule", "run_id", "session_id", "summary"
    ]));
    expect(indexNames(repaired, "pi_approval_requests")).toContain("ux_pi_approval_requests_provider_session_approval");
    expect(repaired.sqlite.query(
      "select session_id, summary, decision from pi_approval_requests where approval_id='approval-old'"
    ).get()).toEqual({ decision: "", session_id: "thread-old", summary: "command=git status" });
  });

  test("keeps migrations idempotent across repeated runtime opens", async () => {
    const second = await reopenAfter(() => {});

    expect(second.sqlite.query("select count(*) as count from schema_migrations").get()).toEqual({ count: MIGRATIONS.length });
    expect(second.sqlite.query("select count(*) as count from projects").get()).toEqual({ count: 0 });
  });

  test("adds Telegram runtime tables without mutating historical Feishu rows and reruns idempotently", () => {
    withMemoryDatabase((sqlite) => {
      runMigrations(sqlite, migrationsBefore("081_telegram_channel_runtime"));
      sqlite.run(`insert into feishu_conversation_state
        (scope_key, active_conversation_id, active_project_id, active_project_source, epoch, started_at, updated_at)
        values ('chat:legacy', 'conversation-legacy', '', '', 0, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`);
      sqlite.run(`insert into sync_outbox
        (source, reply_draft_id, external_event_id, issue_id, target_chat_id, target_thread_id,
         target_message_id, content, status, risk, created_by, approval_action_id, created_at, updated_at,
         feishu_message_id, provider_request_ref)
        values ('feishu', 0, 0, 0, 'oc_legacy', '', '', 'legacy', 'sent', 'low', 'pi', '',
          '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', 'om_legacy', 'om_legacy')`);

      runMigrations(sqlite, [telegramChannelRuntimeMigration]);
      runMigrations(sqlite, [telegramChannelRuntimeMigration]);

      expect(sqlite.query("select scope_key, active_conversation_id from feishu_conversation_state").get()).toEqual({
        active_conversation_id: "conversation-legacy",
        scope_key: "chat:legacy"
      });
      expect(sqlite.query("select source, feishu_message_id, provider_request_ref from sync_outbox").get()).toEqual({
        feishu_message_id: "om_legacy",
        provider_request_ref: "om_legacy",
        source: "feishu"
      });
      expect(sqlite.query("select count(*) as count from schema_migrations where id='081_telegram_channel_runtime'").get())
        .toEqual({ count: 1 });
      expect(sqlite.query<{ name: string }, []>("select name from sqlite_master where type='table'").all().map((row) => row.name))
        .toEqual(expect.arrayContaining(["connector_cursors", "connector_delivery_parts", "connector_update_audits"]));
    });
  });

  test("upgrades the current live 069 schema through the P0 query indexes", async () => {
    const stateDir = await legacyStateDir("070_im_conversation_state", (legacy) => {
      expect(legacy.query("select max(id) as id from schema_migrations").get()).toEqual({ id: "069_builtin_pi_executor_profile" });
    });

    const upgraded = await openRuntime(stateDir);
    expect(upgraded.sqlite.query("select count(*) as count from schema_migrations").get()).toEqual({ count: MIGRATIONS.length });
    expect(tableNames(upgraded)).toEqual(expect.arrayContaining(["im_conversation_state", "im_interaction_bindings", "im_project_selections"]));
    expect(indexNames(upgraded, "issue_events")).toEqual(expect.arrayContaining(["idx_issue_events_type_id", "idx_issue_events_run_event_v1_id_desc"]));
  });

  test("upgrades a 074 database and fails fast when a required query index drifts", async () => {
    const stateDir = await legacyStateDir("075_issue_event_query_indexes");

    const upgraded = await openRuntime(stateDir);
    expect(migrationCount(upgraded, "075_issue_event_query_indexes")).toBe(1);
    expect(migrationCount(upgraded, "076_run_revision_issue_scope_invariant")).toBe(1);
    expect(indexNames(upgraded, "issue_events")).toEqual(expect.arrayContaining(["idx_issue_events_type_id", "idx_issue_events_run_event_v1_id_desc"]));

    withFileDatabase(join(stateDir, "runner.db"), (drifted) => drifted.run("drop index idx_issue_events_run_event_v1_id_desc"));
    await expect(openRuntime(stateDir)).rejects.toThrow(
      "Runner database schema invariant failed: missing required indexes: idx_issue_events_run_event_v1_id_desc"
    );
  });

  test("fails the scoped Run revision migration when historical events belong to another Issue", async () => {
    const stateDir = await legacyStateDir("076_run_revision_issue_scope_invariant", (legacy) => {
      const at = "2026-08-10T00:00:00.000Z";
      legacy.run("insert into projects (id, name, cwd, provider, created_at, updated_at) values ('scope', 'scope', '/tmp/scope', 'codex', ?, ?)", [at, at]);
      const [runIssueID, eventIssueID] = ["run issue", "event issue"].map((title) => {
        legacy.run("insert into issues (project_id, title, status, created_at, updated_at) values ('scope', ?, 'in_progress', ?, ?)", [title, at, at]);
        return Number(legacy.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id);
      });
      legacy.run("insert into issue_runs (id, issue_id, attempt, status, started_at) values ('legacy-run', ?, 1, 'in_progress', ?)", [runIssueID!, at]);
      legacy.run("insert into issue_events (issue_id, type, payload, created_at) values (?, 'run.lifecycle.run_requested.v1', ?, ?)", [
        eventIssueID!, JSON.stringify({ after_revision: 1, run_id: "xw:run:issue_runs:legacy-run" }), at
      ]);
    });

    await expect(openRuntime(stateDir)).rejects.toThrow("Run revision Issue scope invariant failed");
    const check = new Database(join(stateDir, "runner.db"), { readonly: true });
    try {
      expect(check.query("select count(*) as count from schema_migrations where id='076_run_revision_issue_scope_invariant'").get())
        .toEqual({ count: 0 });
    } finally {
      check.close();
    }
  });

  test("opens explicit read-only import database without allowing writes", async () => {
    const dataDir = join(await tempDir(), "data");
    const importPath = join(dataDir, "runner.db");
    await mkdir(dataDir, { recursive: true });
    withFileDatabase(importPath, (db) => {
      db.run("create table items (name text not null)");
      db.run("insert into items (name) values ('fixture')");
    });

    const connection = await openDatabase({ readonlyImportPath: importPath }).then(trackDatabase);

    expect(connection.connectionRole).toBe("reader");
    expect(connection.readonly).toBe(true);
    expect(connection.sqlite.query("pragma busy_timeout").get()).toEqual({ timeout: READONLY_BUSY_TIMEOUT_MS });
    expect(connection.sqlite.query("pragma query_only").get()).toEqual({ query_only: 1 });
    expect(connection.sqlite.query("select name from items").get()).toEqual({ name: "fixture" });
    expect(() => connection.sqlite.run("insert into items (name) values ('write')")).toThrow();
  });

  test("configures WAL connection settings without switching journal mode at startup", async () => {
    const stateDir = await newStateDir();
    const first = await openRuntime(stateDir);
    expect(first.sqlite.query("pragma journal_mode").get()).toEqual({ journal_mode: "delete" });
    first.close();
    withFileDatabase(join(stateDir, "runner.db"), (raw) => raw.query("pragma journal_mode=wal").get());

    const connection = await openRuntime(stateDir);
    expect(connection.sqlite.query("pragma journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(connection.sqlite.query("pragma synchronous").get()).toEqual({ synchronous: 1 });
    expect(connection.sqlite.query("pragma wal_autocheckpoint").get()).toEqual({ wal_autocheckpoint: WAL_AUTOCHECKPOINT_PAGES });
  });

  test("allows the isolated Agentic writer to wait longer for short Core transactions", async () => {
    const connection = await openDatabase({ stateDir: await newStateDir(), writerBusyTimeoutMs: 5_000 }).then(trackDatabase);
    expect(connection.sqlite.query<{ timeout: number }, []>("pragma busy_timeout").get()).toEqual({ timeout: 5_000 });
  });

  test("runs callbacks inside a rollback-capable transaction", async () => {
    const connection = await openRuntime(await newStateDir());
    connection.sqlite.run("create table items (name text not null)");
    const insertThenFail = connection.transaction((name: string) => {
      connection.sqlite.run("insert into items (name) values (?)", [name]);
      throw new Error("rollback fixture");
    });

    expect(() => insertThenFail("rolled-back")).toThrow("rollback fixture");
    expect(connection.sqlite.query("select count(*) as count from items").get()).toEqual({ count: 0 });
  });
}
