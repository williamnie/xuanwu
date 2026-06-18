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
        "cron_task_schedules",
        "cron_tasks",
        "external_events",
        "external_links",
        "feishu_conversation_state",
        "feishu_project_selections",
        "im_reply_drafts",
        "issue_events",
        "issue_runs",
        "issue_supervisor_events",
        "issue_templates",
        "issues",
        "notifications",
        "pi_action_events",
        "pi_actions",
        "pi_agents",
        "pi_approval_requests",
        "pi_conversations",
        "pi_delegations",
        "pi_guardian_decisions",
        "pi_guardian_event_inbox",
        "pi_heartbeat_controls",
        "pi_heartbeat_events",
        "pi_heartbeat_runs",
        "pi_memory_items",
        "pi_notification_intents",
        "pi_notification_preferences",
        "pi_reports",
        "pi_run_group_items",
        "pi_run_groups",
        "pi_skill_intent_audits",
        "project_holds",
        "project_pi_policies",
        "project_pi_settings",
        "projects",
        "schema_migrations",
        "session_command_events",
        "session_turn_references",
        "sqlite_sequence",
        "sync_outbox",
        "uploads"
      ]);
      expect(columnNames(connection, "projects")).toContain("default_agent_profile_id");
      expect(columnNames(connection, "projects")).toContain("default_service_tier");
      expect(columnNames(connection, "issues")).toContain("workflow_snapshot_json");
      expect(columnNames(connection, "issues")).toContain("service_tier");
      expect(columnNames(connection, "issues")).toContain("required_skill_intents_json");
      expect(columnNames(connection, "issues")).toContain("required_mcp_capabilities_json");
      expect(columnNames(connection, "projects")).toContain("default_skill_policy_json");
      expect(columnNames(connection, "projects")).toContain("default_mcp_policy_json");
      expect(columnNames(connection, "pi_delegations")).toContain("allowed_skill_intents_json");
      expect(columnNames(connection, "agent_profiles")).toContain("service_tier");
      expect(columnNames(connection, "pi_delegations")).toContain("allowed_mcp_capabilities_json");
      expect(columnNames(connection, "project_pi_policies")).toContain("allowed_actions_json");
      expect(columnNames(connection, "project_pi_policies")).toContain("allowed_skill_intents_json");
      expect(columnNames(connection, "project_pi_policies")).toContain("allowed_mcp_capabilities_json");
      expect(columnNames(connection, "project_pi_policies")).toContain("verification_policy_json");
      expect(columnNames(connection, "issue_runs")).toContain("provider_session_id");
      expect(columnNames(connection, "issue_runs")).toContain("runtime_metadata_json");
      expect(columnNames(connection, "cron_tasks")).toContain("claim_token");
      expect(columnNames(connection, "cron_tasks")).toContain("claim_started_at");
      expect(columnNames(connection, "pi_reports")).toEqual(expect.arrayContaining([
        "delegation_id",
        "heartbeat_id",
        "issue_ids_json",
        "since_at",
        "source",
        "status",
        "until_at"
      ]));
      expect(connection.sqlite.query("select id from schema_migrations").all()).toEqual([
        { id: "001_base_schema" },
        { id: "002_agent_sessions_runtime" },
        { id: "003_pi_runtime" },
        { id: "004_safe_go_import_tables" },
        { id: "005_read_performance_indexes" },
        { id: "006_pi_action_gate_audit" },
        { id: "007_pi_heartbeat_orchestrator" },
        { id: "008_cron_schedule_layer" },
        { id: "009_skills_registry_intents" },
        { id: "010_mcp_registry_envelope" },
        { id: "011_pi_reports" },
        { id: "012_pi_delegation_envelope" },
        { id: "013_project_pi_policy" },
        { id: "014_cron_task_claims" },
        { id: "015_pi_delegation_skill_intents" },
        { id: "016_pi_delegation_mcp_allowlist" },
        { id: "017_project_pi_policy_allowlists" },
        { id: "018_notifications" },
        { id: "019_execution_service_tier" },
        { id: "020_issue_supervisor_recovery" },
        { id: "021_external_events" },
        { id: "022_external_links" },
        { id: "023_im_reply_outbox" },
        { id: "024_im_reply_outbox_dispatch" },
        { id: "025_feishu_conversation_state" },
        { id: "026_feishu_project_selection" },
        { id: "027_pi_approval_requests" },
        { id: "028_pi_guardian_runtime" }
      ]);
      expect(indexNames(connection, "issue_events")).toContain("idx_issue_events_issue_type");
      expect(columnNames(connection, "pi_actions")).toContain("gate_decision");
      expect(columnNames(connection, "pi_actions")).toEqual(expect.arrayContaining([
        "before_snapshot_json",
        "expected_state_json",
        "guardian_decision_id",
        "idempotency_key",
        "lease_expires_at",
        "lease_key",
        "legacy_bypass_reason"
      ]));
      expect(columnNames(connection, "pi_approval_requests")).toEqual(expect.arrayContaining([
        "approval_id",
        "decision",
        "delivery_state",
        "run_id",
        "session_id",
        "summary"
      ]));
      expect(columnNames(connection, "pi_approval_requests")).toEqual(expect.arrayContaining([
        "async_escalation_state",
        "fast_decision",
        "fast_decision_reason",
        "fast_policy_latency_ms",
        "fast_policy_rule"
      ]));
      expect(indexNames(connection, "pi_action_events")).toContain("idx_pi_action_events_action");
      expect(indexNames(connection, "pi_heartbeat_events")).toContain("idx_pi_heartbeat_events_run");
      expect(indexNames(connection, "pi_delegations")).toContain("idx_pi_delegations_active");
      expect(indexNames(connection, "pi_delegations")).toContain("idx_pi_delegations_window");
      expect(indexNames(connection, "pi_reports")).toContain("idx_pi_reports_delegation");
      expect(indexNames(connection, "issue_supervisor_events")).toContain("idx_issue_supervisor_events_issue");
      expect(indexNames(connection, "external_events")).toContain("idx_external_events_source_dedupe");
      expect(indexNames(connection, "external_events")).toContain("idx_external_events_received");
      expect(indexNames(connection, "external_links")).toContain("idx_external_links_external");
      expect(indexNames(connection, "pi_approval_requests")).toContain("idx_pi_approval_requests_issue");
      expect(indexNames(connection, "pi_approval_requests")).toContain("ux_pi_approval_requests_provider_session_approval");
      expect(indexNames(connection, "pi_guardian_event_inbox")).toContain("ux_pi_guardian_event_source");
      expect(indexNames(connection, "pi_guardian_decisions")).toContain("ux_pi_guardian_decisions_key");
      expect(indexNames(connection, "pi_actions")).toContain("ux_pi_actions_idempotency_key");
      expect(indexNames(connection, "pi_actions")).toContain("idx_pi_actions_guardian_decision");
      expect(indexNames(connection, "pi_actions")).toContain("idx_pi_actions_lease_key");
      expect(indexNames(connection, "pi_notification_intents")).toContain("ux_pi_notification_intent_key");
      expect(indexNames(connection, "pi_notification_preferences")).toContain("idx_pi_notification_preferences_scope");
      expect(indexNames(connection, "pi_notification_preferences")).toContain("idx_pi_notification_preferences_effective");
      expect(indexNames(connection, "pi_run_group_items")).toContain("idx_pi_run_group_items_status");
      expect(indexNames(connection, "external_links")).toContain("idx_external_links_issue");
      expect(indexNames(connection, "feishu_conversation_state")).toContain("idx_feishu_conversation_state_updated");
      expect(indexNames(connection, "feishu_conversation_state")).toContain("idx_feishu_conversation_state_project");

      expect(columnDefaults(connection, "pi_delegations")).toMatchObject({
        allowed_actions_json: "'[]'",
        allowed_mcp_capabilities_json: "'[]'",
        allowed_skill_intents_json: "'[]'",
        audit_source: "''",
        expires_at: "''",
        forbidden_actions_json: "'[]'",
        scope_json: "'{}'",
        starts_at: "''",
        status: "'active'"
      });
      expect(columnDefaults(connection, "project_pi_policies")).toMatchObject({
        allowed_actions_json: "'[]'",
        allowed_mcp_capabilities_json: "'[]'",
        allowed_skill_intents_json: "'[]'",
        allowed_supervisor_actions_json: "'[]'",
        supervisor_cooldown_seconds: "300",
        supervisor_max_recoveries_per_issue: "2",
        supervisor_max_recoveries_per_project_per_hour: "10",
        supervisor_mode: "'watchdog'",
        supervisor_rate_limit_wait_policy: "'respect_retry_after'",
        verification_policy_json: "'{\"pending_timeout_minutes\":1440,\"on_timeout\":\"escalate\",\"evidence_required\":true}'"
      });
      expect(columnDefaults(connection, "pi_reports")).toMatchObject({
        issue_ids_json: "'[]'",
        source: "'manual'",
        status: "'generated'"
      });
      expect(columnDefaults(connection, "external_events")).toMatchObject({
        actor: "''",
        external_id: "''",
        normalized_message_json: "'{}'",
        project_id: "''",
        project_hint: "''",
        raw_payload_ref: "''",
        status: "'inbox'",
        summary_json: "'{}'",
        trust_level: "'untrusted'"
      });
      expect(columnDefaults(connection, "external_links")).toMatchObject({
        conversation_id: "''",
        external_event_id: "0",
        external_id: "''",
        external_type: "''",
        issue_id: "0",
        loop_run_id: "''",
        project_id: "''",
        relationship: "'related'"
      });
      expect(columnDefaults(connection, "sync_outbox")).toMatchObject({
        attempt_count: "0",
        cooldown_until: "''",
        feishu_message_id: "''",
        last_error: "''",
        max_attempts: "3",
        retry_after_seconds: "0",
        sent_at: "''"
      });
      expect(columnDefaults(connection, "feishu_conversation_state")).toMatchObject({
        active_project_id: "''",
        active_project_source: "''",
        epoch: "0"
      });
      expect(columnDefaults(connection, "pi_approval_requests")).toMatchObject({
        decision: "''",
        delivery_state: "'pending'",
        run_id: "''",
        session_id: "''",
        summary: "''",
        fast_decision: "''",
        fast_policy_latency_ms: "0",
        async_escalation_state: "''"
      });
      expect(columnDefaults(connection, "pi_guardian_event_inbox")).toMatchObject({
        redaction_profile: "'prompt'",
        severity: "'info'",
        status: "'pending'"
      });
      expect(columnDefaults(connection, "pi_run_groups")).toMatchObject({
        digest_policy_json: "'{}'",
        max_interval_minutes: "120",
        status: "'active'"
      });
      expect(columnDefaults(connection, "pi_run_group_items")).toMatchObject({
        enqueue_status: "'pending'",
        report_bucket: "'active'",
        report_status: "'active'",
        status: "'active'"
      });
      expect(columnDefaults(connection, "pi_notification_intents")).toMatchObject({
        decision: "'aggregate'",
        flush_reason: "''",
        flush_sequence: "0",
        state: "'pending'"
      });
      expect(columnNames(connection, "pi_notification_preferences")).toEqual(expect.arrayContaining([
        "confirmation_text",
        "digest_policy_json",
        "effective_after_sequence",
        "expires_at",
        "mode",
        "notify_on_json",
        "policy_kind",
        "scope"
      ]));
      expect(columnDefaults(connection, "pi_notification_preferences")).toMatchObject({
        confirmation_text: "''",
        digest_policy_json: "'{}'",
        effective_after_sequence: "0",
        expires_at: "''",
        mode: "'normal'",
        notify_on_json: "'[]'",
        policy_kind: "'user_preference'",
        status: "'active'"
      });
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

  test("repairs older approval request tables after the migration row exists", async () => {
    const root = await tempPath("codex-runner-bun-approval-drift-");
    const stateDir = join(root, "state");
    const first = await openDatabase({ stateDir });
    first.close();

    const raw = new Database(join(stateDir, "runner.db"));
    try {
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
      raw.run(`insert into pi_approval_requests (
        approval_id, project_id, issue_id, provider, thread_id, request_type,
        request_summary, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        "approval-old", "demo", 393, "codex", "thread-old", "command",
        "command=git status", "2026-06-14T00:00:00Z", "2026-06-14T00:00:00Z"
      ]);
    } finally {
      raw.close();
    }

    const repaired = await openDatabase({ stateDir });
    try {
      expect(columnNames(repaired, "pi_approval_requests")).toEqual(expect.arrayContaining([
        "async_escalation_state",
        "decision",
        "delivery_state",
        "fast_decision",
        "fast_policy_latency_ms",
        "fast_policy_rule",
        "run_id",
        "session_id",
        "summary"
      ]));
      expect(indexNames(repaired, "pi_approval_requests")).toContain("ux_pi_approval_requests_provider_session_approval");
      expect(repaired.sqlite.query(
        "select session_id, summary, decision from pi_approval_requests where approval_id='approval-old'"
      ).get()).toEqual({
        decision: "",
        session_id: "thread-old",
        summary: "command=git status"
      });
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
      expect(second.sqlite.query("select count(*) as count from schema_migrations").get()).toEqual({ count: 28 });
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

function columnDefaults(connection: RunnerDatabase, table: string): Record<string, string | null> {
  return Object.fromEntries(connection.sqlite.query(`pragma table_info(${table})`).all()
    .map((row) => {
      const column = row as { dflt_value: string | null; name: string };
      return [column.name, column.dflt_value];
    }));
}

function indexNames(connection: RunnerDatabase, table: string): string[] {
  return connection.sqlite.query(`pragma index_list(${table})`).all()
    .map((row) => (row as { name: string }).name);
}
