import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  READONLY_BUSY_TIMEOUT_MS,
  WAL_AUTOCHECKPOINT_PAGES,
  WRITER_BUSY_TIMEOUT_MS,
  openDatabase,
  type RunnerDatabase
} from "./database.ts";

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
      expect(connection.connectionRole).toBe("writer");
      expect(connection.sqlite.query("pragma busy_timeout").get()).toEqual({ timeout: WRITER_BUSY_TIMEOUT_MS });
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
        "assistant_tool_providers",
        "assistant_tools",
        "attention_command_events",
        "attention_inbox_items",
        "automation_definitions",
        "automation_events",
        "automation_execution_links",
        "automation_run_events",
        "automation_runs",
        "automation_trigger_configs",
        "automation_watches",
        "context_bundles",
        "cron_task_schedules",
        "cron_tasks",
        "event_projection_watermarks",
        "event_summary_projection",
        "event_summary_projection_compact",
        "event_summary_projection_compat_modes",
        "event_summary_projection_payloads",
        "event_summary_projection_projects",
        "event_summary_projection_runs",
        "event_summary_projection_switch",
        "event_summary_projection_types",
        "external_events",
        "external_links",
        "feishu_conversation_state",
        "feishu_project_selections",
        "git_repo_mapping_events",
        "git_repo_mappings",
        "im_reply_drafts",
        "intake_runs",
        "issue_events",
        "issue_runs",
        "issue_supervisor_events",
        "issues",
        "notifications",
        "pi_action_events",
        "pi_action_proposals",
        "pi_actions",
        "pi_agents",
        "pi_approval_requests",
        "pi_automations",
        "pi_conversations",
        "pi_delegations",
        "pi_guardian_alerts",
        "pi_guardian_decisions",
        "pi_guardian_event_inbox",
        "pi_guardian_watchdog_status",
        "pi_heartbeat_controls",
        "pi_heartbeat_events",
        "pi_heartbeat_runs",
        "pi_issue_completion_watch_items",
        "pi_issue_completion_watches",
        "pi_mcp_approval_grants",
        "pi_mcp_capabilities",
        "pi_mcp_servers",
        "pi_memory_items",
        "pi_notification_intents",
        "pi_notification_preferences",
        "pi_persona",
        "pi_recovery_attempts",
        "pi_reports",
        "pi_run_group_items",
        "pi_run_groups",
        "pi_skill_intent_audits",
        "project_holds",
        "project_pi_policies",
        "project_pi_settings",
        "projects",
        "run_attempts",
        "schema_migrations",
        "session_command_events",
        "session_turn_references",
        "sqlite_sequence",
        "sync_outbox",
        "tracker_issue_links",
        "tracker_project_mappings",
        "tracker_sync_cursors",
        "tracker_sync_events",
        "uploads",
        "work_events",
        "work_relations",
        "works"
      ]);
      expect(columnNames(connection, "projects")).toContain("default_agent_profile_id");
      expect(columnNames(connection, "automation_runs")).toEqual(expect.arrayContaining([
        "attempt_count", "lease_expires_at", "lease_token", "max_attempts", "next_attempt_at", "scheduled_for"
      ]));
      expect(columnNames(connection, "projects")).toContain("default_service_tier");
      expect(columnNames(connection, "issues")).toContain("workflow_snapshot_json");
      expect(columnNames(connection, "issues")).toContain("service_tier");
      expect(columnNames(connection, "issues")).toContain("required_skill_intents_json");
      expect(columnNames(connection, "issues")).toContain("required_mcp_capabilities_json");
      expect(columnNames(connection, "issues")).toEqual(expect.arrayContaining([
        "dependency_declaration_error",
        "dependency_issue_ids_json"
      ]));
      expect(columnNames(connection, "projects")).toContain("default_skill_policy_json");
      expect(columnNames(connection, "projects")).toContain("default_mcp_policy_json");
      expect(columnNames(connection, "pi_delegations")).toContain("allowed_skill_intents_json");
      expect(columnNames(connection, "agent_profiles")).toContain("service_tier");
      expect(columnNames(connection, "pi_delegations")).toContain("allowed_mcp_capabilities_json");
      expect(columnNames(connection, "project_pi_policies")).toContain("allowed_actions_json");
      expect(columnNames(connection, "project_pi_policies")).toContain("allowed_skill_intents_json");
      expect(columnNames(connection, "project_pi_policies")).toContain("allowed_mcp_capabilities_json");
      expect(columnNames(connection, "project_pi_policies")).toContain("verification_policy_json");
      expect(columnNames(connection, "pi_mcp_servers")).toEqual(expect.arrayContaining(["enabled", "env_json", "redaction_json", "source_path", "transport_type"]));
      expect(columnNames(connection, "pi_mcp_capabilities")).toEqual(expect.arrayContaining(["enabled", "permission", "read_only", "requires_confirmation", "risk_level"]));
      expect(columnNames(connection, "issue_runs")).toContain("provider_session_id");
      expect(columnNames(connection, "issue_runs")).toContain("runtime_metadata_json");
      expect(columnNames(connection, "issue_runs")).toContain("git_base_revision");
      expect(generatedColumnNames(connection, "issue_runs")).toEqual(expect.arrayContaining([
        "run_id",
        "run_sequence",
        "work_id"
      ]));
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
      expect(columnNames(connection, "pi_memory_items")).toEqual(expect.arrayContaining([
        "citation_id",
        "citation_label",
        "citation_type",
        "citation_url",
        "layer",
        "memory_type"
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
        { id: "028_pi_guardian_runtime" },
        { id: "029_pi_issue_completion_watches" },
        { id: "030_remove_legacy_notification_settings" },
        { id: "031_clear_feishu_pi_conversation_projects" },
        { id: "032_assistant_tool_registry" },
        { id: "033_context_bundles" },
        { id: "034_intake_runs" },
        { id: "035_pi_automations" },
        { id: "036_pi_automation_scheduler" },
        { id: "037_pi_action_proposals" },
        { id: "038_pi_memory_store_metadata" },
        { id: "039_pi_mcp_discovery" },
        { id: "040_event_summary_projection" },
        { id: "041_work_ledger_schema" },
        { id: "042_run_attempt_relations" },
        { id: "043_tracker_update_outbox" },
        { id: "044_attention_command_events" },
        { id: "045_automation_model" },
        { id: "046_automation_scheduler" },
        { id: "047_git_provider_events" },
        { id: "048_tracker_issue_sync" },
        { id: "049_automation_execution_links" },
        { id: "050_automation_watches" },
        { id: "051_remove_production_fixtures" },
        { id: "052_consolidate_pi_decision_layers" },
        { id: "054_compact_event_summary_projection" },
        { id: "055_collapse_pi_agents_to_supervisor" },
        { id: "056_issue_log_mode" },
        { id: "057_issue_dependency_and_run_git_baseline" },
        { id: "058_drop_issue_templates" },
        { id: "059_pi_automatic_takeover" },
        { id: "060_mcp_approval_policy" },
        { id: "061_project_mandatory_takeover" },
        { id: "062_reusable_pi_memory" },
        { id: "063_pi_persona" }
      ]);
      expect(indexNames(connection, "issue_events")).toContain("idx_issue_events_issue_type");
      expect(indexNames(connection, "issue_events")).toContain("idx_issue_events_issue_id_desc");
      expect(columnNames(connection, "issues")).toContain("issue_log_mode");
      expect(columnNames(connection, "issues")).not.toContain("template_id");
      expect(columnNames(connection, "issues")).not.toContain("prompt_template");
      expect(indexNames(connection, "event_summary_projection")).toEqual(expect.arrayContaining([
        "idx_event_summary_projection_issue",
        "idx_event_summary_projection_project"
      ]));
      expect(indexNames(connection, "event_summary_projection_compact")).toEqual(expect.arrayContaining([
        "idx_event_summary_projection_compact_issue",
        "idx_event_summary_projection_compact_project"
      ]));
      expect(columnNames(connection, "event_summary_projection_compact")).toEqual(expect.arrayContaining([
        "event_type_ref",
        "payload_ref",
        "project_ref",
        "run_ref",
        "source_event_id",
        "source_sha256"
      ]));
      expect(columnNames(connection, "event_projection_watermarks")).toEqual(expect.arrayContaining([
        "last_event_id",
        "projected_row_count",
        "projection_id",
        "projector_version"
      ]));
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
      expect(indexNames(connection, "external_events")).toContain("idx_external_events_source_external");
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
      expect(indexNames(connection, "pi_recovery_attempts")).toEqual(expect.arrayContaining([
        "idx_pi_recovery_attempts_decision",
        "idx_pi_recovery_attempts_issue_window",
        "idx_pi_recovery_attempts_project_window",
        "idx_pi_recovery_attempts_session_window",
        "ux_pi_recovery_attempts_key"
      ]));
      expect(indexNames(connection, "pi_run_group_items")).toContain("idx_pi_run_group_items_status");
      expect(indexNames(connection, "pi_issue_completion_watches")).toContain("ux_pi_issue_completion_watches_active_key");
      expect(indexNames(connection, "pi_issue_completion_watch_items")).toContain("idx_pi_issue_completion_watch_items_issue");
      expect(indexNames(connection, "automation_watches")).toEqual(expect.arrayContaining([
        "idx_automation_watches_due",
        "ux_automation_watches_dedupe",
        "ux_automation_watches_legacy"
      ]));
      expect(indexNames(connection, "external_links")).toContain("idx_external_links_issue");
      expect(indexNames(connection, "sync_outbox")).toEqual(expect.arrayContaining([
        "idx_sync_outbox_operation_dispatch",
        "ux_sync_outbox_tracker_dedupe"
      ]));
      expect(indexSQL(connection, "idx_sync_outbox_reply_draft")).toContain("where reply_draft_id > 0");
      expect(indexNames(connection, "feishu_conversation_state")).toContain("idx_feishu_conversation_state_updated");
      expect(indexNames(connection, "feishu_conversation_state")).toContain("idx_feishu_conversation_state_project");
      expect(indexNames(connection, "intake_runs")).toContain("idx_intake_runs_bundle");
      expect(indexNames(connection, "attention_inbox_items")).toContain("idx_attention_inbox_items_intake_run");
      expect(indexNames(connection, "pi_automations")).toContain("idx_pi_automations_due");
      expect(indexNames(connection, "pi_action_proposals")).toContain("idx_pi_action_proposals_status");
      expect(indexNames(connection, "pi_action_proposals")).toContain("idx_pi_action_proposals_skill_run");

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
        allowed_supervisor_actions_json: "'[\"session.resume_followup\",\"issue.retry_after\",\"issue.retry\",\"issue.state_repair\",\"needs_user.escalate\"]'",
        supervisor_cooldown_seconds: "300",
        supervisor_max_recoveries_per_issue: "2",
        supervisor_max_recoveries_per_project_per_hour: "10",
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
        attachments_json: "'[]'",
        event_type: "'message'",
        external_id: "''",
        normalized_message_json: "'{}'",
        occurred_at: "''",
        project_id: "''",
        project_hint: "''",
        provider: "''",
        raw_json: "'{}'",
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
        attention_ref: "''",
        attempt_count: "0",
        cooldown_until: "''",
        correlation_id: "''",
        dedupe_key: "''",
        feishu_message_id: "''",
        handoff_id: "''",
        last_error: "''",
        max_attempts: "3",
        operation_kind: "'im_reply'",
        payload_json: "'{}'",
        project_id: "''",
        provider_request_ref: "''",
        result_json: "'{}'",
        retry_after_seconds: "0",
        sent_at: "''",
        target_external_id: "''",
        target_external_type: "''",
        work_id: "''"
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
      expect(columnDefaults(connection, "pi_issue_completion_watches")).toMatchObject({
        completed_at: "''",
        condition: "'{}'",
        error: "''",
        notified_at: "''",
        status: "'active'"
      });
      expect(columnDefaults(connection, "pi_issue_completion_watch_items")).toMatchObject({
        initial_status: "''",
        last_status: "''",
        terminal_at: "''"
      });
      expect(columnDefaults(connection, "automation_watches")).toMatchObject({
        error: "''",
        expires_at: "''",
        last_external_event_id: "0",
        legacy_watch_id: "''",
        notified_at: "''",
        outcome: "''",
        satisfied_at: "''"
      });
      expect(columnDefaults(connection, "assistant_tool_providers")).toMatchObject({
        audit_json: '\'{"redact":[]}\'',
        default_timeout_ms: "0",
        metadata_json: "'{}'",
        status: "'enabled'"
      });
      expect(columnDefaults(connection, "assistant_tools")).toMatchObject({
        audit_json: '\'{"redact":[]}\'',
        input_schema_json: "'{}'",
        metadata_json: "'{}'",
        output_schema_json: "'{}'",
        permission: "'read'",
        timeout_ms: "0"
      });
      expect(columnDefaults(connection, "intake_runs")).toMatchObject({
        error: "''",
        ignored_groups_json: "'[]'",
        input_summary_json: "'{}'",
        model: "''",
        model_policy_id: "''",
        schema_output_json: "'{}'",
        status: "'running'"
      });
      expect(columnDefaults(connection, "attention_inbox_items")).toMatchObject({
        actor_refs_json: "'[]'",
        evidence_refs_json: "'[]'",
        kind: "'attention'",
        schema_item_json: "'{}'",
        secondary_intents_json: "'[]'",
        status: "'new'",
        suggested_actions_json: "'[]'",
        target_hints_json: "'[]'",
        urgency: "''"
      });
      expect(columnDefaults(connection, "pi_automations")).toMatchObject({
        failed_cursor: "''",
        last_successful_cursor: "''",
        lock_token: "''",
        processed_watermark: "''",
        retry_backoff_seconds: "60",
        retry_count: "0",
        run_timeout_ms: "300000"
      });
      expect(columnDefaults(connection, "pi_recovery_attempts")).toMatchObject({
        after_snapshot_json: "'{}'",
        ignored_reasons_json: "'[]'",
        progress_detected: "0",
        progress_reasons_json: "'[]'",
        status: "'planned'"
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

  test("bootstraps a default PI agent for a fresh runtime database", async () => {
    const root = await tempPath("codex-runner-bun-default-pi-agent-");
    const connection = await openDatabase({ stateDir: join(root, "state") });

    try {
      expect(connection.sqlite.query("select count(*) as count from pi_agents").get()).toEqual({ count: 1 });
      expect(connection.sqlite.query("select id, name, provider, thinking_level, cwd_policy, instructions, enabled from pi_agents").get()).toEqual({
        id: "runner-default",
        name: "Xuanwu Supervisor",
        provider: "pi-sdk",
        thinking_level: "medium",
        cwd_policy: "project",
        instructions: "你是玄武 Xuanwu Supervisor，作为 Engineering Chief of Staff 将工程目标组织为 Work，监督 Run，以 Evidence 判定完成，并产出可审查的 Handoff；所有写操作必须经过确定性权限与审计门禁。",
        enabled: 1
      });
    } finally {
      connection.close();
    }
  });

  test("adds runner-default when upgrading a database that only has a legacy PI agent", async () => {
    const root = await tempPath("codex-runner-bun-legacy-pi-agent-");
    const stateDir = join(root, "state");
    const first = await openDatabase({ stateDir });
    first.sqlite.run("delete from pi_agents where id='runner-default'");
    first.sqlite.run(
      `insert into pi_agents
        (id, name, model_provider, model_id, thinking_level, instructions, enabled, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "pi-default",
        "Legacy PI",
        "pi-smoke-faux",
        "faux-1",
        "off",
        "legacy instructions",
        1,
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z"
      ]
    );
    first.sqlite.run(
      `insert into project_pi_settings (project_id, created_at, updated_at) values (?, ?, ?)`,
      ["legacy-project", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
    );
    first.sqlite.run(
      `insert into pi_conversations
        (id, pi_agent_id, created_at, updated_at) values (?, ?, ?, ?)`,
      ["legacy-conversation", "pi-default", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
    );
    first.close();

    const upgraded = await openDatabase({ stateDir });

    try {
      expect(upgraded.sqlite.query("select id from pi_agents order by id").all()).toEqual([{ id: "runner-default" }]);
      expect(upgraded.sqlite.query("select project_id from project_pi_settings where project_id='legacy-project'").get())
        .toEqual({ project_id: "legacy-project" });
      expect(upgraded.sqlite.query("select pi_agent_id from pi_conversations where id='legacy-conversation'").get())
        .toEqual({ pi_agent_id: "runner-default" });
      expect(upgraded.sqlite.query("select id, name, model_provider, model_id, thinking_level, instructions, enabled from pi_agents where id='runner-default'").get()).toEqual({
        id: "runner-default",
        name: "Legacy PI",
        model_provider: "pi-smoke-faux",
        model_id: "faux-1",
        thinking_level: "off",
        instructions: "legacy instructions",
        enabled: 1
      });
    } finally {
      upgraded.close();
    }
  });

  test("collapses legacy agent data when the singleton Supervisor migration is pending", async () => {
    const root = await tempPath("codex-runner-bun-collapse-pi-agents-");
    const stateDir = join(root, "state");
    const first = await openDatabase({ stateDir });
    first.close();

    const raw = new Database(join(stateDir, "runner.db"));
    try {
      raw.run("delete from schema_migrations where id='055_collapse_pi_agents_to_supervisor'");
      raw.run(
        `update pi_agents set name='Runner Brain', instructions=? where id='runner-default'`,
        ["你是全局 Runner Brain，负责观察所有项目、调度 sessions/issues、提出 action 建议并沉淀记忆。"]
      );
      raw.run(
        `insert into pi_agents (id, name, created_at, updated_at) values (?, ?, ?, ?)`,
        ["legacy-extra", "Legacy Extra", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
      );
      raw.run(
        `insert into project_pi_settings (project_id, created_at, updated_at) values (?, ?, ?)`,
        ["legacy-extra-project", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
      );
      raw.run(
        `insert into pi_conversations (id, pi_agent_id, created_at, updated_at) values (?, ?, ?, ?)`,
        ["legacy-extra-conversation", "legacy-extra", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
      );
    } finally {
      raw.close();
    }

    const migrated = await openDatabase({ stateDir });
    try {
      expect(migrated.sqlite.query("select count(*) as count from pi_agents").get()).toEqual({ count: 1 });
      expect(migrated.sqlite.query("select id, name, instructions from pi_agents").get()).toEqual({
        id: "runner-default",
        name: "Xuanwu Supervisor",
        instructions: "你是玄武 Xuanwu Supervisor，作为 Engineering Chief of Staff 将工程目标组织为 Work，监督 Run，以 Evidence 判定完成，并产出可审查的 Handoff；所有写操作必须经过确定性权限与审计门禁。"
      });
      expect(migrated.sqlite.query("select project_id from project_pi_settings where project_id='legacy-extra-project'").get())
        .toEqual({ project_id: "legacy-extra-project" });
      expect(migrated.sqlite.query("select pi_agent_id from pi_conversations where id='legacy-extra-conversation'").get())
        .toEqual({ pi_agent_id: "runner-default" });
    } finally {
      migrated.close();
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

  test("removes legacy notification settings when cleanup migration is pending", async () => {
    const root = await tempPath("codex-runner-bun-legacy-notification-settings-");
    const stateDir = join(root, "state");
    const first = await openDatabase({ stateDir });
    first.close();

    const raw = new Database(join(stateDir, "runner.db"));
    try {
      raw.run("delete from schema_migrations where id='030_remove_legacy_notification_settings'");
      raw.run("insert into app_preferences (key, value, updated_at) values (?, ?, ?)", [
        "notifications.settings",
        "{\"events\":[\"done\"]}",
        "2026-07-02T00:00:00Z"
      ]);
    } finally {
      raw.close();
    }

    const migrated = await openDatabase({ stateDir });
    try {
      expect(migrated.sqlite.query("select value from app_preferences where key='notifications.settings'").get()).toBeNull();
      expect(migrated.sqlite.query("select count(*) as count from schema_migrations where id='030_remove_legacy_notification_settings'").get()).toEqual({ count: 1 });
    } finally {
      migrated.close();
    }
  });

  test("clears stale Feishu PI conversation project bindings when cleanup migration is pending", async () => {
    const root = await tempPath("codex-runner-bun-feishu-pi-project-cleanup-");
    const stateDir = join(root, "state");
    const first = await openDatabase({ stateDir });
    first.close();

    const raw = new Database(join(stateDir, "runner.db"));
    try {
      raw.run("delete from schema_migrations where id='031_clear_feishu_pi_conversation_projects'");
      raw.run(`insert into pi_agents
        (id, name, model_provider, model_id, thinking_level, enabled, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?)`, [
        "pi-faux", "PI Faux", "test", "faux-1", "off", 1,
        "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"
      ]);
      raw.run(`insert into pi_conversations
        (id, project_id, pi_agent_id, title, status, session_file, pi_session_id, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        "feishu-chat-oc_fixture-20260705", "codex-issue-runner", "pi-faux",
        "Feishu · oc_fixture", "active", "/tmp/feishu.jsonl", "feishu-chat-oc_fixture-20260705",
        "2026-07-05T00:00:00Z", "2026-07-05T00:00:00Z"
      ]);
      raw.run(`insert into pi_conversations
        (id, project_id, pi_agent_id, title, status, session_file, pi_session_id, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        "runner-chat", "demo", "pi-faux", "Runner", "active", "/tmp/runner.jsonl",
        "runner-chat", "2026-07-05T00:00:00Z", "2026-07-05T00:00:00Z"
      ]);
      raw.run(`insert into agent_sessions
        (session_key, provider, provider_session_id, agent_role, project_id, issue_id,
         title, preview, status, raw_ref, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        "pi-sdk:feishu-chat-oc_fixture-20260705", "pi-sdk", "feishu-chat-oc_fixture-20260705",
        "pi_manager", "codex-issue-runner", 0, "Feishu · oc_fixture", "", "active",
        "{\"conversation_id\":\"feishu-chat-oc_fixture-20260705\"}",
        "2026-07-05T00:00:00Z", "2026-07-05T00:00:00Z"
      ]);
      raw.run(`insert into agent_sessions
        (session_key, provider, provider_session_id, agent_role, project_id, issue_id,
         title, preview, status, raw_ref, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        "pi-sdk:runner-chat", "pi-sdk", "runner-chat", "pi_manager", "demo", 0,
        "Runner", "", "active", "{\"conversation_id\":\"runner-chat\"}",
        "2026-07-05T00:00:00Z", "2026-07-05T00:00:00Z"
      ]);
    } finally {
      raw.close();
    }

    const migrated = await openDatabase({ stateDir });
    try {
      expect(migrated.sqlite.query("select project_id from pi_conversations where id='feishu-chat-oc_fixture-20260705'").get())
        .toEqual({ project_id: "" });
      expect(migrated.sqlite.query("select project_id from agent_sessions where session_key='pi-sdk:feishu-chat-oc_fixture-20260705'").get())
        .toEqual({ project_id: "" });
      expect(migrated.sqlite.query("select project_id from pi_conversations where id='runner-chat'").get())
        .toEqual({ project_id: "demo" });
      expect(migrated.sqlite.query("select project_id from agent_sessions where session_key='pi-sdk:runner-chat'").get())
        .toEqual({ project_id: "demo" });
      expect(migrated.sqlite.query("select count(*) as count from schema_migrations where id='031_clear_feishu_pi_conversation_projects'").get())
        .toEqual({ count: 1 });
    } finally {
      migrated.close();
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
      expect(second.sqlite.query("select count(*) as count from schema_migrations").get()).toEqual({ count: 62 });
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
      expect(connection.connectionRole).toBe("reader");
      expect(connection.readonly).toBe(true);
      expect(connection.sqlite.query("pragma busy_timeout").get()).toEqual({ timeout: READONLY_BUSY_TIMEOUT_MS });
      expect(connection.sqlite.query("pragma query_only").get()).toEqual({ query_only: 1 });
      expect(connection.sqlite.query("select name from items").get()).toEqual({ name: "fixture" });
      expect(() => connection.sqlite.run("insert into items (name) values ('write')")).toThrow();
    } finally {
      connection.close();
    }
  });

  test("configures WAL connection settings without switching journal mode at startup", async () => {
    const root = await tempPath("codex-runner-bun-wal-settings-");
    const stateDir = join(root, "state");
    const first = await openDatabase({ stateDir });
    expect(first.sqlite.query("pragma journal_mode").get()).toEqual({ journal_mode: "delete" });
    first.close();

    const raw = new Database(join(stateDir, "runner.db"));
    raw.query("pragma journal_mode=wal").get();
    raw.close();

    const connection = await openDatabase({ stateDir });
    try {
      expect(connection.sqlite.query("pragma journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(connection.sqlite.query("pragma synchronous").get()).toEqual({ synchronous: 1 });
      expect(connection.sqlite.query("pragma wal_autocheckpoint").get()).toEqual({ wal_autocheckpoint: WAL_AUTOCHECKPOINT_PAGES });
    } finally {
      connection.close();
    }
  });

  test("allows the isolated Agentic writer to wait longer for short Core transactions", async () => {
    const root = await tempPath("codex-runner-bun-agentic-writer-");
    const connection = await openDatabase({ stateDir: join(root, "state"), writerBusyTimeoutMs: 5_000 });
    try {
      expect(connection.sqlite.query<{ timeout: number }, []>("pragma busy_timeout").get()).toEqual({ timeout: 5_000 });
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

function generatedColumnNames(connection: RunnerDatabase, table: string): string[] {
  return connection.sqlite.query(`pragma table_xinfo(${table})`).all()
    .filter((row) => (row as { hidden: number }).hidden !== 0)
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

function indexSQL(connection: RunnerDatabase, index: string): string {
  const row = connection.sqlite.query<{ sql: string }, [string]>(
    "select sql from sqlite_master where type='index' and name=?"
  ).get(index);
  return row?.sql ?? "";
}
