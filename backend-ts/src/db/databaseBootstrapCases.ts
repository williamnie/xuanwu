import { expect, test } from "bun:test";

import { existsSync } from "node:fs";

import { join } from "node:path";
import { WRITER_BUSY_TIMEOUT_MS, type RunnerDatabase } from "./database.ts";

import { imInteractionBindingConstraintsMigration } from "./schema/072_im_interaction_binding_constraints.ts";
import { imInteractionResolutionLeaseMigration } from "./schema/073_im_interaction_resolution_lease.ts";

import { FIXTURE_TIME } from "../testing/harness.ts";
import {
  SUPERVISOR_INSTRUCTIONS,
  newStateDir,
  openRuntime,
  reopenAfter,
  withMemoryDatabase,
  insertLegacyAgentReferences,
  expectLegacyAgentReferencesMoved,
  migrationCount,
  tableNames,
  columnNames,
  generatedColumnNames,
  columnDefaults,
  indexNames,
  indexSQL,
  TABLES,
  MIGRATIONS,
  COLUMNS,
  INDEXES,
  DEFAULTS
} from "./databaseTestFixtures.ts";

export function registerDatabaseBootstrapCases() {
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
}
