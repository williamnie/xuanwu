export function words(text: string): string[] {
  return text.trim().split(/\s+/);
}

export const TABLES = words(`
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
  pi_skill_intent_audits project_holds project_pi_policies project_pi_settings projects remote_runs run_attempts
  schema_migrations session_command_events session_turn_references sqlite_sequence sqlite_stat1 sync_outbox
  tracker_issue_links tracker_project_mappings tracker_sync_cursors tracker_sync_events uploads work_events
  work_relations works
`);

export const MIGRATIONS = words(`
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
  090_pi_credential_source 091_hot_path_read_indexes 092_remote_nodes 093_remote_runs
`);

export const COLUMNS: Record<string, string[]> = {
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

export const INDEXES: Record<string, string[]> = {
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

export const DEFAULTS: Record<string, Record<string, string>> = {
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
