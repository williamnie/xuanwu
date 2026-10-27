import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  READONLY_BUSY_TIMEOUT_MS,
  WAL_AUTOCHECKPOINT_PAGES,
  WRITER_BUSY_TIMEOUT_MS,
  openDatabase,
  type RunnerDatabase
} from "./database.ts";
import { runMigrations } from "./migrations.ts";
import { migrations } from "./schema/index.ts";
import { imInteractionBindingConstraintsMigration } from "./schema/072_im_interaction_binding_constraints.ts";
import { imInteractionResolutionLeaseMigration } from "./schema/073_im_interaction_resolution_lease.ts";
import { telegramChannelRuntimeMigration } from "./schema/081_telegram_channel_runtime.ts";
import { FIXTURE_TIME, useDatabaseCleanup, useTempDirs } from "../testing/harness.ts";

const trackDatabase = useDatabaseCleanup();
const tempDir = useTempDirs("xuanwu-bun-db-");
const SUPERVISOR_INSTRUCTIONS = "先回答用户真正关心的问题，再补必要理由；说人话，避免不必要的内部术语和流程播报。";

describe("Bun SQLite database connection", () => {
  test("upgrades an early 071 interaction table additively and idempotently", () => {
    withMemoryDatabase((sqlite) => {
      sqlite.run(`create table im_interaction_bindings (
        interaction_id text primary key,
        connector_id text not null,
        action_kind text not null,
        action_ref text not null,
        scope_key text not null,
        status text not null default 'pending'
      )`);
      for (const migration of [imInteractionBindingConstraintsMigration, imInteractionBindingConstraintsMigration,
        imInteractionResolutionLeaseMigration, imInteractionResolutionLeaseMigration]) migration.apply?.(sqlite);
      expect(columnNames({ sqlite } as RunnerDatabase, "im_interaction_bindings")).toEqual(expect.arrayContaining([
        "actions_json", "actor_id", "actor_open_id", "claimed_action_id", "lease_id",
        "lease_expires_at", "resolution_json", "resolved_at"
      ]));
    });
  });

  test("creates the state directory and default runner database", async () => {
    const stateDir = await newStateDir();
    const connection = await openRuntime(stateDir);

    connection.sqlite.run("create table items (name text not null)");
    connection.sqlite.run("insert into items (name) values (?)", ["alpha"]);

    expect(connection.path).toBe(join(stateDir, "runner.db"));
    expect(existsSync(stateDir)).toBe(true);
    expect(existsSync(connection.path)).toBe(true);
    expect(connection.connectionRole).toBe("writer");
    expect(connection.sqlite.query("pragma busy_timeout").get()).toEqual({ timeout: WRITER_BUSY_TIMEOUT_MS });
    expect(connection.sqlite.query("select name from items").get()).toEqual({ name: "alpha" });
  });

  test("runs the base schema migration on an empty runtime database", async () => {
    const connection = await openRuntime(await newStateDir());

    expect(tableNames(connection)).toEqual(TABLES);
    expect(connection.sqlite.query<{ id: string }, []>("select id from schema_migrations").all().map((row) => row.id))
      .toEqual(MIGRATIONS);
    for (const [table, columns] of Object.entries(COLUMNS)) {
      expect(columnNames(connection, table)).toEqual(expect.arrayContaining(columns));
    }
    expect(columnNames(connection, "issues")).not.toContain("template_id");
    expect(columnNames(connection, "issues")).not.toContain("prompt_template");
    expect(columnNames(connection, "project_pi_policies")).not.toContain("verification_policy_json");
    expect(generatedColumnNames(connection, "issue_runs")).toEqual(expect.arrayContaining(["run_id", "run_sequence", "work_id"]));
    for (const [table, indexes] of Object.entries(INDEXES)) {
      expect(indexNames(connection, table)).toEqual(expect.arrayContaining(indexes));
    }
    expect(indexSQL(connection, "idx_sync_outbox_reply_draft")).toContain("where reply_draft_id > 0");
    for (const [table, defaults] of Object.entries(DEFAULTS)) {
      expect(columnDefaults(connection, table)).toMatchObject(defaults);
    }
  });

  test("bootstraps a default PI agent for a fresh runtime database", async () => {
    const connection = await openRuntime(await newStateDir());

    expect(connection.sqlite.query("select count(*) as count from pi_agents").get()).toEqual({ count: 1 });
    expect(connection.sqlite.query("select id, name, provider, thinking_level, cwd_policy, instructions, enabled from pi_agents").get()).toEqual({
      id: "runner-default",
      name: "Xuanwu Supervisor",
      provider: "pi-sdk",
      thinking_level: "medium",
      cwd_policy: "project",
      instructions: SUPERVISOR_INSTRUCTIONS,
      enabled: 1
    });
  });

  test("updates only the legacy Supervisor instructions and preserves user customization", async () => {
    const migrated = await reopenAfter((raw) => {
      raw.run("update pi_agents set instructions='用户自己的表达偏好' where id='runner-default'");
      raw.run("delete from schema_migrations where id='084_supervisor_natural_instructions'");
    });

    expect(migrated.sqlite.query("select instructions from pi_agents where id='runner-default'").get())
      .toEqual({ instructions: "用户自己的表达偏好" });
  });

  test("adds runner-default when upgrading a database that only has a legacy PI agent", async () => {
    const upgraded = await reopenAfter((raw) => {
      raw.run("delete from pi_agents where id='runner-default'");
      raw.run(
        `insert into pi_agents (id, name, model_provider, model_id, thinking_level, instructions, enabled, created_at, updated_at)
         values ('pi-default', 'Legacy PI', 'pi-smoke-faux', 'faux-1', 'off', 'legacy instructions', 1, ?, ?)`,
        [FIXTURE_TIME, FIXTURE_TIME]
      );
      insertLegacyAgentReferences(raw, "legacy-project", "legacy-conversation", "pi-default");
    });

    expect(upgraded.sqlite.query("select id from pi_agents order by id").all()).toEqual([{ id: "runner-default" }]);
    expectLegacyAgentReferencesMoved(upgraded, "legacy-project", "legacy-conversation");
    expect(upgraded.sqlite.query("select id, name, model_provider, model_id, thinking_level, instructions, enabled from pi_agents where id='runner-default'").get()).toEqual({
      id: "runner-default",
      name: "Legacy PI",
      model_provider: "pi-smoke-faux",
      model_id: "faux-1",
      thinking_level: "off",
      instructions: "legacy instructions",
      enabled: 1
    });
  });

  test("collapses legacy agent data when the singleton Supervisor migration is pending", async () => {
    const migrated = await reopenAfter((raw) => {
      raw.run("delete from schema_migrations where id='055_collapse_pi_agents_to_supervisor'");
      raw.run(
        `update pi_agents set name='Runner Brain', instructions=? where id='runner-default'`,
        ["你是全局 Runner Brain，负责观察所有项目、调度 sessions/issues、提出 action 建议并沉淀记忆。"]
      );
      raw.run("insert into pi_agents (id, name, created_at, updated_at) values ('legacy-extra', 'Legacy Extra', ?, ?)", [FIXTURE_TIME, FIXTURE_TIME]);
      insertLegacyAgentReferences(raw, "legacy-extra-project", "legacy-extra-conversation", "legacy-extra");
    });

    expect(migrated.sqlite.query("select count(*) as count from pi_agents").get()).toEqual({ count: 1 });
    expect(migrated.sqlite.query("select id, name, instructions from pi_agents").get()).toEqual({
      id: "runner-default",
      name: "Xuanwu Supervisor",
      instructions: SUPERVISOR_INSTRUCTIONS
    });
    expectLegacyAgentReferencesMoved(migrated, "legacy-extra-project", "legacy-extra-conversation");
  });

  test("repairs schema drift when a migration row exists but tables are missing", async () => {
    const repaired = await reopenAfter((raw) => {
      raw.run("drop table project_holds");
      raw.run("drop table cron_tasks");
    });

    expect(tableNames(repaired)).toEqual(expect.arrayContaining(["project_holds", "cron_tasks"]));
    expect(migrationCount(repaired, "004_safe_go_import_tables")).toBe(1);
  });

  test("removes legacy notification settings when cleanup migration is pending", async () => {
    const migrated = await reopenAfter((raw) => {
      raw.run("delete from schema_migrations where id='030_remove_legacy_notification_settings'");
      raw.run("insert into app_preferences (key, value, updated_at) values (?, ?, ?)", [
        "notifications.settings", "{\"events\":[\"done\"]}", "2026-07-02T00:00:00Z"
      ]);
    });

    expect(migrated.sqlite.query("select value from app_preferences where key='notifications.settings'").get()).toBeNull();
    expect(migrationCount(migrated, "030_remove_legacy_notification_settings")).toBe(1);
  });

  test("clears stale Feishu PI conversation project bindings when cleanup migration is pending", async () => {
    const at = "2026-07-05T00:00:00Z";
    const conversations = [["feishu-chat-oc_fixture-20260705", "xuanwu", "Feishu · oc_fixture"], ["runner-chat", "demo", "Runner"]];
    const migrated = await reopenAfter((raw) => {
      raw.run("delete from schema_migrations where id='031_clear_feishu_pi_conversation_projects'");
      raw.run(`insert into pi_agents (id, name, model_provider, model_id, thinking_level, enabled, created_at, updated_at)
        values ('pi-faux', 'PI Faux', 'test', 'faux-1', 'off', 1, ?, ?)`, [FIXTURE_TIME, FIXTURE_TIME]);
      for (const [id, projectID, title] of conversations) {
        raw.run(`insert into pi_conversations
          (id, project_id, pi_agent_id, title, status, session_file, pi_session_id, created_at, updated_at)
          values (?, ?, 'pi-faux', ?, 'active', ?, ?, ?, ?)`, [id, projectID, title, `/tmp/${id}.jsonl`, id, at, at]);
        raw.run(`insert into agent_sessions
          (session_key, provider, provider_session_id, agent_role, project_id, issue_id, title, preview, status, raw_ref, created_at, updated_at)
          values (?, 'pi-sdk', ?, 'pi_manager', ?, 0, ?, '', 'active', ?, ?, ?)`,
        [`pi-sdk:${id}`, id, projectID, title, JSON.stringify({ conversation_id: id }), at, at]);
      }
    });

    for (const [id, project_id] of [["feishu-chat-oc_fixture-20260705", ""], ["runner-chat", "demo"]]) {
      expect(migrated.sqlite.query("select project_id from pi_conversations where id=?").get(id)).toEqual({ project_id });
      expect(migrated.sqlite.query("select project_id from agent_sessions where session_key=?").get(`pi-sdk:${id}`)).toEqual({ project_id });
    }
    expect(migrationCount(migrated, "031_clear_feishu_pi_conversation_projects")).toBe(1);
  });

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
});

async function newStateDir(): Promise<string> {
  return join(await tempDir(), "state");
}

function openRuntime(stateDir: string): Promise<RunnerDatabase> {
  return openDatabase({ stateDir }).then(trackDatabase);
}

/** Creates a fresh runtime database, edits the closed file with `mutate`, and reopens it through the migrations. */
async function reopenAfter(mutate: (raw: Database) => void): Promise<RunnerDatabase> {
  const stateDir = await newStateDir();
  (await openDatabase({ stateDir })).close();
  withFileDatabase(join(stateDir, "runner.db"), mutate);
  return openRuntime(stateDir);
}

/** A state dir whose runner.db only has the migrations before `boundary`, optionally edited by `seed`. */
async function legacyStateDir(boundary: string, seed: (legacy: Database) => void = () => {}): Promise<string> {
  const stateDir = await newStateDir();
  await mkdir(stateDir, { recursive: true });
  withFileDatabase(join(stateDir, "runner.db"), (legacy) => {
    runMigrations(legacy, migrationsBefore(boundary));
    seed(legacy);
  });
  return stateDir;
}

function withFileDatabase(path: string, use: (db: Database) => unknown): void {
  const db = new Database(path);
  try {
    use(db);
  } finally {
    db.close();
  }
}

function withMemoryDatabase(use: (db: Database) => void): void {
  withFileDatabase(":memory:", use);
}

function insertLegacyAgentReferences(raw: Database, projectID: string, conversationID: string, agentID: string): void {
  raw.run("insert into project_pi_settings (project_id, created_at, updated_at) values (?, ?, ?)", [projectID, FIXTURE_TIME, FIXTURE_TIME]);
  raw.run("insert into pi_conversations (id, pi_agent_id, created_at, updated_at) values (?, ?, ?, ?)", [conversationID, agentID, FIXTURE_TIME, FIXTURE_TIME]);
}

function expectLegacyAgentReferencesMoved(db: RunnerDatabase, projectID: string, conversationID: string): void {
  expect(db.sqlite.query("select project_id from project_pi_settings where project_id=?").get(projectID)).toEqual({ project_id: projectID });
  expect(db.sqlite.query("select pi_agent_id from pi_conversations where id=?").get(conversationID)).toEqual({ pi_agent_id: "runner-default" });
}

function migrationCount(db: RunnerDatabase, id: string): number {
  return db.sqlite.query<{ count: number }, [string]>("select count(*) as count from schema_migrations where id=?").get(id)?.count ?? 0;
}

function migrationsBefore(id: string): typeof migrations {
  const index = migrations.findIndex((migration) => migration.id === id);
  if (index < 0) throw new Error(`Unknown migration fixture boundary: ${id}`);
  return migrations.slice(0, index);
}

function tableNames(connection: RunnerDatabase): string[] {
  return connection.sqlite.query<{ name: string }, []>("select name from sqlite_master where type='table' order by name asc")
    .all().map((row) => row.name);
}

function columnNames(connection: RunnerDatabase, table: string): string[] {
  return connection.sqlite.query<{ name: string }, []>(`pragma table_info(${table})`).all().map((row) => row.name);
}

function generatedColumnNames(connection: RunnerDatabase, table: string): string[] {
  return connection.sqlite.query<{ hidden: number; name: string }, []>(`pragma table_xinfo(${table})`).all()
    .filter((row) => row.hidden !== 0).map((row) => row.name);
}

function columnDefaults(connection: RunnerDatabase, table: string): Record<string, string | null> {
  return Object.fromEntries(connection.sqlite.query<{ dflt_value: string | null; name: string }, []>(`pragma table_info(${table})`)
    .all().map((column) => [column.name, column.dflt_value]));
}

function indexNames(connection: RunnerDatabase, table: string): string[] {
  return connection.sqlite.query<{ name: string }, []>(`pragma index_list(${table})`).all().map((row) => row.name);
}

function indexSQL(connection: RunnerDatabase, index: string): string {
  return connection.sqlite.query<{ sql: string }, [string]>("select sql from sqlite_master where type='index' and name=?").get(index)?.sql ?? "";
}

function words(text: string): string[] {
  return text.trim().split(/\s+/);
}

const TABLES = words(`
  agent_profiles agent_sessions app_preferences assistant_tool_providers assistant_tools attention_command_events
  attention_inbox_items automation_definitions automation_events automation_execution_links automation_run_events
  automation_runs automation_trigger_configs automation_watches connector_cursors connector_delivery_parts
  connector_update_audits context_bundles cron_task_schedules cron_tasks event_projection_watermarks
  event_summary_projection event_summary_projection_compact event_summary_projection_compat_modes
  event_summary_projection_payloads event_summary_projection_projects event_summary_projection_runs
  event_summary_projection_switch event_summary_projection_types external_events external_links
  feishu_conversation_state feishu_project_selections git_repo_mapping_events git_repo_mappings github_issue_cases
  im_context_cursors im_context_event_bindings im_context_rollovers im_conversation_state im_interaction_bindings
  im_project_selections im_reply_drafts intake_runs issue_events issue_runs issue_supervisor_events issues
  nodes notifications pi_action_events pi_action_proposals pi_actions pi_agents pi_approval_requests pi_automations
  pi_conversations pi_delegations pi_guardian_alerts pi_guardian_decisions pi_guardian_event_inbox
  pi_guardian_watchdog_status pi_heartbeat_controls pi_heartbeat_events pi_heartbeat_runs
  pi_issue_completion_watch_items pi_issue_completion_watches pi_mcp_approval_grants pi_mcp_capabilities
  pi_mcp_servers pi_memory_history pi_memory_items pi_memory_receipts pi_memory_reflection_cursor
  pi_memory_reflection_settings pi_memory_reflections pi_memory_suppressions pi_notification_intents
  pi_notification_preferences pi_persona pi_recovery_attempts pi_reports pi_run_group_items pi_run_groups
  pi_skill_intent_audits project_holds project_pi_policies project_pi_settings projects run_attempts
  schema_migrations session_command_events session_turn_references sqlite_sequence sqlite_stat1 sync_outbox
  tracker_issue_links tracker_project_mappings tracker_sync_cursors tracker_sync_events uploads work_events
  work_relations works
`);

const MIGRATIONS = words(`
  001_base_schema 002_agent_sessions_runtime 003_pi_runtime 004_safe_go_import_tables 005_read_performance_indexes
  006_pi_action_gate_audit 007_pi_heartbeat_orchestrator 008_cron_schedule_layer 009_skills_registry_intents
  010_mcp_registry_envelope 011_pi_reports 012_pi_delegation_envelope 013_project_pi_policy 014_cron_task_claims
  015_pi_delegation_skill_intents 016_pi_delegation_mcp_allowlist 017_project_pi_policy_allowlists 018_notifications
  019_execution_service_tier 020_issue_supervisor_recovery 021_external_events 022_external_links 023_im_reply_outbox
  024_im_reply_outbox_dispatch 025_feishu_conversation_state 026_feishu_project_selection 027_pi_approval_requests
  028_pi_guardian_runtime 029_pi_issue_completion_watches 030_remove_legacy_notification_settings
  031_clear_feishu_pi_conversation_projects 032_assistant_tool_registry 033_context_bundles 034_intake_runs
  035_pi_automations 036_pi_automation_scheduler 037_pi_action_proposals 038_pi_memory_store_metadata
  039_pi_mcp_discovery 040_event_summary_projection 041_work_ledger_schema 042_run_attempt_relations
  043_tracker_update_outbox 044_attention_command_events 045_automation_model 046_automation_scheduler
  047_git_provider_events 048_tracker_issue_sync 049_automation_execution_links 050_automation_watches
  051_remove_production_fixtures 052_consolidate_pi_decision_layers 054_compact_event_summary_projection
  055_collapse_pi_agents_to_supervisor 056_issue_log_mode 057_issue_dependency_and_run_git_baseline
  058_drop_issue_templates 059_pi_automatic_takeover 060_mcp_approval_policy 061_project_mandatory_takeover
  062_reusable_pi_memory 063_pi_persona 064_pi_owned_issue_lifecycle 065_unlimited_project_recovery_budget
  066_pi_context_memory_authority 067_compact_event_summary_created_at 068_builtin_executor_profiles
  069_builtin_pi_executor_profile 070_im_conversation_state 070a_im_conversation_state_backfill
  071_im_interaction_bindings 071a_im_project_selections_backfill 072_im_interaction_binding_constraints
  073_im_interaction_resolution_lease 074_im_outbound_dedupe 075_issue_event_query_indexes
  076_run_revision_issue_scope_invariant 077_pi_action_event_connector_test_index 078_builtin_qoder_executor_profile
  079_scheduler_performance_indexes 080_execution_policy_json 081_telegram_channel_runtime 082_im_context_lifecycle
  083_attention_action_recent_index 084_supervisor_natural_instructions 085_runtime_read_indexes
  086_github_issue_cases 087_pi_memory_history 088_pi_memory_reflections 089_runtime_activity_indexes
  090_pi_credential_source 091_hot_path_read_indexes 092_remote_nodes
`);

/** Columns later migrations added; each table must contain at least these. */
const COLUMNS: Record<string, string[]> = {
  projects: words("default_agent_profile_id default_service_tier default_skill_policy_json default_mcp_policy_json"),
  automation_runs: words("attempt_count lease_expires_at lease_token max_attempts next_attempt_at scheduled_for"),
  issues: words(`
    workflow_snapshot_json service_tier required_skill_intents_json required_mcp_capabilities_json
    dependency_declaration_error dependency_issue_ids_json issue_log_mode
  `),
  pi_delegations: words("allowed_skill_intents_json allowed_mcp_capabilities_json"),
  agent_profiles: words("service_tier"),
  project_pi_policies: words("allowed_actions_json allowed_skill_intents_json allowed_mcp_capabilities_json"),
  pi_mcp_servers: words("enabled env_json redaction_json source_path transport_type"),
  pi_mcp_capabilities: words("enabled permission read_only requires_confirmation risk_level"),
  issue_runs: words("provider_session_id runtime_metadata_json git_base_revision"),
  cron_tasks: words("claim_token claim_started_at"),
  pi_reports: words("delegation_id heartbeat_id issue_ids_json since_at source status until_at"),
  pi_memory_items: words(`
    citation_id citation_label citation_type citation_url authority authorized_at authorized_by layer memory_type
  `),
  event_summary_projection_compact: words(`
    event_type_ref event_created_at payload_ref project_ref run_ref source_event_id source_sha256
  `),
  event_projection_watermarks: words("last_event_id projected_row_count projection_id projector_version"),
  pi_actions: words(`
    gate_decision before_snapshot_json expected_state_json guardian_decision_id idempotency_key lease_expires_at
    lease_key legacy_bypass_reason
  `),
  pi_approval_requests: words(`
    approval_id decision delivery_state run_id session_id summary async_escalation_state fast_decision
    fast_decision_reason fast_policy_latency_ms fast_policy_rule
  `),
  pi_notification_preferences: words(`
    confirmation_text digest_policy_json effective_after_sequence expires_at mode notify_on_json policy_kind scope
  `)
};

/** Indexes the read and claim paths depend on. */
const INDEXES: Record<string, string[]> = {
  issue_events: words(`
    idx_issue_events_issue_type idx_issue_events_issue_id_desc idx_issue_events_type_id
    idx_issue_events_run_event_v1_id_desc
  `),
  pi_actions: words(`
    idx_pi_actions_attention_recent idx_pi_actions_pending_notification idx_pi_actions_pending_mcp_expiry
    ux_pi_actions_idempotency_key idx_pi_actions_guardian_decision idx_pi_actions_lease_key
  `),
  pi_notification_intents: words("idx_pi_notification_intents_kind_source ux_pi_notification_intent_key"),
  agent_sessions: words("idx_agent_sessions_issue_updated"),
  event_summary_projection: words("idx_event_summary_projection_issue idx_event_summary_projection_project"),
  event_summary_projection_compact: words(`
    idx_event_summary_projection_compact_issue idx_event_summary_projection_compact_project
  `),
  pi_action_events: words("idx_pi_action_events_action idx_pi_action_events_connector_test_history"),
  pi_heartbeat_events: words("idx_pi_heartbeat_events_run"),
  pi_delegations: words("idx_pi_delegations_active idx_pi_delegations_window"),
  pi_reports: words("idx_pi_reports_delegation"),
  issue_supervisor_events: words("idx_issue_supervisor_events_issue"),
  external_events: words(`
    idx_external_events_source_dedupe idx_external_events_source_external idx_external_events_received
  `),
  external_links: words("idx_external_links_external idx_external_links_issue"),
  pi_approval_requests: words("idx_pi_approval_requests_issue ux_pi_approval_requests_provider_session_approval"),
  pi_guardian_event_inbox: words("ux_pi_guardian_event_source"),
  pi_guardian_decisions: words("ux_pi_guardian_decisions_key"),
  pi_notification_preferences: words("idx_pi_notification_preferences_scope idx_pi_notification_preferences_effective"),
  pi_recovery_attempts: words(`
    idx_pi_recovery_attempts_decision idx_pi_recovery_attempts_issue_window idx_pi_recovery_attempts_project_window
    idx_pi_recovery_attempts_session_window ux_pi_recovery_attempts_key
  `),
  pi_run_group_items: words("idx_pi_run_group_items_status"),
  pi_issue_completion_watches: words("ux_pi_issue_completion_watches_active_key"),
  pi_issue_completion_watch_items: words("idx_pi_issue_completion_watch_items_issue"),
  automation_watches: words("idx_automation_watches_due ux_automation_watches_dedupe ux_automation_watches_legacy"),
  sync_outbox: words("idx_sync_outbox_operation_dispatch ux_sync_outbox_tracker_dedupe"),
  feishu_conversation_state: words("idx_feishu_conversation_state_updated idx_feishu_conversation_state_project"),
  im_conversation_state: words("idx_im_conversation_state_updated"),
  im_interaction_bindings: words("idx_im_interaction_bindings_status"),
  im_project_selections: words("idx_im_project_selections_status idx_im_project_selections_scope"),
  intake_runs: words("idx_intake_runs_bundle"),
  attention_inbox_items: words("idx_attention_inbox_items_intake_run"),
  pi_automations: words("idx_pi_automations_due"),
  pi_action_proposals: words("idx_pi_action_proposals_status idx_pi_action_proposals_skill_run")
};

/** Column defaults that callers rely on when they omit a value. */
const DEFAULTS: Record<string, Record<string, string>> = {
  pi_delegations: {
    allowed_actions_json: "'[]'", allowed_mcp_capabilities_json: "'[]'", allowed_skill_intents_json: "'[]'",
    audit_source: "''", expires_at: "''", forbidden_actions_json: "'[]'", scope_json: "'{}'", starts_at: "''",
    status: "'active'"
  },
  project_pi_policies: {
    allowed_actions_json: "'[]'", allowed_mcp_capabilities_json: "'[]'", allowed_skill_intents_json: "'[]'",
    allowed_supervisor_actions_json: "'[\"session.resume_followup\",\"issue.retry_after\",\"issue.retry\",\"issue.state_repair\",\"needs_user.escalate\"]'",
    supervisor_cooldown_seconds: "300", supervisor_max_recoveries_per_issue: "6",
    supervisor_max_recoveries_per_project_per_hour: "0", supervisor_rate_limit_wait_policy: "'respect_retry_after'"
  },
  pi_reports: { issue_ids_json: "'[]'", source: "'manual'", status: "'generated'" },
  external_events: {
    actor: "''", attachments_json: "'[]'", event_type: "'message'", external_id: "''", normalized_message_json: "'{}'",
    occurred_at: "''", project_id: "''", project_hint: "''", provider: "''", raw_json: "'{}'", raw_payload_ref: "''",
    status: "'inbox'", summary_json: "'{}'", trust_level: "'untrusted'"
  },
  external_links: {
    conversation_id: "''", external_event_id: "0", external_id: "''", external_type: "''", issue_id: "0",
    loop_run_id: "''", project_id: "''", relationship: "'related'"
  },
  sync_outbox: {
    attention_ref: "''", attempt_count: "0", cooldown_until: "''", correlation_id: "''", dedupe_key: "''",
    feishu_message_id: "''", handoff_id: "''", last_error: "''", max_attempts: "3", operation_kind: "'im_reply'",
    payload_json: "'{}'", project_id: "''", provider_request_ref: "''", result_json: "'{}'", retry_after_seconds: "0",
    sent_at: "''", target_external_id: "''", target_external_type: "''", work_id: "''"
  },
  feishu_conversation_state: { active_project_id: "''", active_project_source: "''", epoch: "0" },
  pi_approval_requests: {
    decision: "''", delivery_state: "'pending'", run_id: "''", session_id: "''", summary: "''", fast_decision: "''",
    fast_policy_latency_ms: "0", async_escalation_state: "''"
  },
  pi_guardian_event_inbox: { redaction_profile: "'prompt'", severity: "'info'", status: "'pending'" },
  pi_run_groups: { digest_policy_json: "'{}'", max_interval_minutes: "120", status: "'active'" },
  pi_run_group_items: {
    enqueue_status: "'pending'", report_bucket: "'active'", report_status: "'active'", status: "'active'"
  },
  pi_notification_intents: { decision: "'aggregate'", flush_reason: "''", flush_sequence: "0", state: "'pending'" },
  pi_issue_completion_watches: {
    completed_at: "''", condition: "'{}'", error: "''", notified_at: "''", status: "'active'"
  },
  pi_issue_completion_watch_items: { initial_status: "''", last_status: "''", terminal_at: "''" },
  automation_watches: {
    error: "''", expires_at: "''", last_external_event_id: "0", legacy_watch_id: "''", notified_at: "''", outcome: "''",
    satisfied_at: "''"
  },
  assistant_tool_providers: {
    audit_json: "'{\"redact\":[]}'", default_timeout_ms: "0", metadata_json: "'{}'", status: "'enabled'"
  },
  assistant_tools: {
    audit_json: "'{\"redact\":[]}'", input_schema_json: "'{}'", metadata_json: "'{}'", output_schema_json: "'{}'",
    permission: "'read'", timeout_ms: "0"
  },
  intake_runs: {
    error: "''", ignored_groups_json: "'[]'", input_summary_json: "'{}'", model: "''", model_policy_id: "''",
    schema_output_json: "'{}'", status: "'running'"
  },
  attention_inbox_items: {
    actor_refs_json: "'[]'", evidence_refs_json: "'[]'", kind: "'attention'", schema_item_json: "'{}'",
    secondary_intents_json: "'[]'", status: "'new'", suggested_actions_json: "'[]'", target_hints_json: "'[]'",
    urgency: "''"
  },
  pi_automations: {
    failed_cursor: "''", last_successful_cursor: "''", lock_token: "''", processed_watermark: "''",
    retry_backoff_seconds: "60", retry_count: "0", run_timeout_ms: "300000"
  },
  pi_recovery_attempts: {
    after_snapshot_json: "'{}'", ignored_reasons_json: "'[]'", progress_detected: "0", progress_reasons_json: "'[]'",
    status: "'planned'"
  },
  pi_notification_preferences: {
    confirmation_text: "''", digest_policy_json: "'{}'", effective_after_sequence: "0", expires_at: "''",
    mode: "'normal'", notify_on_json: "'[]'", policy_kind: "'user_preference'", status: "'active'"
  }
};
