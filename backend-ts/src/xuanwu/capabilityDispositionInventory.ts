export type CapabilityDisposition = "keep" | "merge" | "migrate" | "delete";
export type DataRetention = "R0_DERIVED" | "R1_OPERATIONAL" | "R2_DURABLE" | "R3_AUDIT" | "R4_SENSITIVE";

export const LIVE_REFERENCE = {
  captured_at: "2026-07-15T23:42:00+08:00",
  database_path_kind: "launchd --db runner.db",
  runtime_commit: "16fee2e2a0e0",
  runtime_version: "v0.1.0-543-g16fee2e",
  source_head_at_capture: "356271efc165",
  table_count: 59
} as const;

export const RETENTION_LEVELS = {
  R0_DERIVED: "可重建 projection/cache；验证无引用后即可丢弃",
  R1_OPERATIONAL: "保留到活动执行结束并满足配置的运维观察窗",
  R2_DURABLE: "保留整个 project/local-control-plane 生命周期并纳入备份",
  R3_AUDIT: "不可变审计/工程历史；仅按显式保留策略导出后删除",
  R4_SENSITIVE: "会话、附件、凭据相关或个人化内容；最小化访问并按引用生命周期清理"
} as const satisfies Record<DataRetention, string>;

export const TABLE_DISPOSITIONS = [
  {
    name: "agent_profiles", disposition: "keep", target: "Executor configuration",
    source_of_truth: "agent_profiles", retention: "R2_DURABLE", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "agent_sessions", disposition: "merge", target: "Run.provider_session_ref drill-down",
    source_of_truth: "agent_sessions + provider session files", retention: "R2_DURABLE", runtime_origin: "source_schema",
    live_rows: 416, delete_preconditions: []
  },
  {
    name: "app_preferences", disposition: "merge", target: "Local control-plane settings",
    source_of_truth: "app_preferences", retention: "R2_DURABLE", runtime_origin: "source_schema",
    live_rows: 1, delete_preconditions: []
  },
  {
    name: "assistant_tool_providers", disposition: "keep", target: "Capability registry",
    source_of_truth: "assistant_tool_providers", retention: "R2_DURABLE", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "assistant_tools", disposition: "keep", target: "Capability registry",
    source_of_truth: "assistant_tools", retention: "R2_DURABLE", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "attention_command_events", disposition: "keep", target: "Attention command audit",
    source_of_truth: "attention_command_events", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "attention_inbox_items", disposition: "keep", target: "Attention primary carrier",
    source_of_truth: "attention_inbox_items", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "automation_definitions", disposition: "keep", target: "Automation definition authority",
    source_of_truth: "automation_definitions", retention: "R2_DURABLE", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "automation_events", disposition: "keep", target: "Automation audit ledger",
    source_of_truth: "automation_events", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "automation_execution_links", disposition: "keep", target: "Automation Work and Run relations",
    source_of_truth: "automation_execution_links", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "automation_run_events", disposition: "keep", target: "Automation Run audit",
    source_of_truth: "automation_run_events", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "automation_runs", disposition: "keep", target: "Automation execution authority",
    source_of_truth: "automation_runs", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "automation_trigger_configs", disposition: "keep", target: "Automation trigger configuration",
    source_of_truth: "automation_trigger_configs", retention: "R2_DURABLE", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "automation_watches", disposition: "keep", target: "Automation observation authority",
    source_of_truth: "automation_watches", retention: "R2_DURABLE", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "context_bundles", disposition: "merge", target: "Evidence input projection",
    source_of_truth: "context_bundles; source events remain authoritative", retention: "R0_DERIVED", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "cron_task_schedules", disposition: "migrate", target: "Automation.trigger and cursor",
    source_of_truth: "cron_task_schedules until Automation parity", retention: "R2_DURABLE", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "cron_tasks", disposition: "migrate", target: "Automation definition",
    source_of_truth: "cron_tasks until Automation parity", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 3, delete_preconditions: []
  },
  {
    name: "event_projection_watermarks", disposition: "keep", target: "Event projection cursor",
    source_of_truth: "event_projection_watermarks", retention: "R1_OPERATIONAL", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "event_summary_projection", disposition: "keep", target: "Bounded event summary projection",
    source_of_truth: "event_summary_projection; issue_events remain authoritative", retention: "R0_DERIVED", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "external_events", disposition: "keep", target: "Intake Evidence",
    source_of_truth: "external_events", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 49, delete_preconditions: []
  },
  {
    name: "external_links", disposition: "keep", target: "Cross-system provenance",
    source_of_truth: "external_links", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 102, delete_preconditions: []
  },
  {
    name: "feishu_conversation_state", disposition: "keep", target: "Connector cursor/state",
    source_of_truth: "feishu_conversation_state", retention: "R1_OPERATIONAL", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "feishu_project_selections", disposition: "merge", target: "Project-scope connector preference",
    source_of_truth: "feishu_project_selections", retention: "R2_DURABLE", runtime_origin: "source_schema",
    live_rows: 2, delete_preconditions: []
  },
  {
    name: "git_repo_mapping_events", disposition: "keep", target: "Git mapping audit",
    source_of_truth: "git_repo_mapping_events", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "git_repo_mappings", disposition: "keep", target: "Git repository mapping authority",
    source_of_truth: "git_repo_mappings", retention: "R2_DURABLE", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "im_reply_drafts", disposition: "merge", target: "Handoff delivery proposal",
    source_of_truth: "im_reply_drafts", retention: "R4_SENSITIVE", runtime_origin: "source_schema",
    live_rows: 52, delete_preconditions: []
  },
  {
    name: "intake_runs", disposition: "merge", target: "Attention intake execution audit",
    source_of_truth: "intake_runs; not a core Run", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "issue_events", disposition: "keep", target: "Work events and Evidence authority",
    source_of_truth: "issue_events", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 460891, delete_preconditions: []
  },
  {
    name: "issue_runs", disposition: "keep", target: "Run authority",
    source_of_truth: "issue_runs", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 560, delete_preconditions: []
  },
  {
    name: "issue_supervisor_events", disposition: "keep", target: "Run recovery Evidence",
    source_of_truth: "issue_supervisor_events", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 2008, delete_preconditions: []
  },
  {
    name: "issue_templates", disposition: "keep", target: "Work creation templates",
    source_of_truth: "issue_templates", retention: "R2_DURABLE", runtime_origin: "source_schema",
    live_rows: 1, delete_preconditions: []
  },
  {
    name: "issues", disposition: "keep", target: "Work authority",
    source_of_truth: "issues", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 742, delete_preconditions: []
  },
  {
    name: "nightly_batch_items", disposition: "delete", target: "Archived legacy nightly-batch export",
    source_of_truth: "live legacy table only", retention: "R3_AUDIT", runtime_origin: "live_legacy_only",
    live_rows: 5, delete_preconditions: ["Export rows together with nightly_batches and preserve the parent-child mapping.", "Prove zero references in the deployed runtime and current source for one release observation window.", "Delete only after nightly_batches archival, backup/restore rehearsal, and audited migration approval."]
  },
  {
    name: "nightly_batches", disposition: "delete", target: "Archived legacy nightly-batch export",
    source_of_truth: "live legacy table only", retention: "R3_AUDIT", runtime_origin: "live_legacy_only",
    live_rows: 1, delete_preconditions: ["Export all rows with schema and checksum into a reviewable archive.", "Prove zero references in the deployed runtime and current source for one release observation window.", "Complete live DB backup/restore rehearsal before an audited destructive migration."]
  },
  {
    name: "notifications", disposition: "migrate", target: "Attention notification projection",
    source_of_truth: "notifications until parity with Attention delivery", retention: "R1_OPERATIONAL", runtime_origin: "source_schema",
    live_rows: 32, delete_preconditions: []
  },
  {
    name: "pi_action_events", disposition: "keep", target: "Evidence and external-effect audit",
    source_of_truth: "pi_action_events", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 3169, delete_preconditions: []
  },
  {
    name: "pi_action_proposals", disposition: "keep", target: "Deterministic permission proposal",
    source_of_truth: "pi_action_proposals", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "pi_actions", disposition: "merge", target: "Handoff or Automation action candidate",
    source_of_truth: "pi_actions", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 731, delete_preconditions: []
  },
  {
    name: "pi_agents", disposition: "merge", target: "Local control-plane assistant configuration",
    source_of_truth: "pi_agents", retention: "R2_DURABLE", runtime_origin: "source_schema",
    live_rows: 1, delete_preconditions: []
  },
  {
    name: "pi_approval_requests", disposition: "merge", target: "Attention permission request",
    source_of_truth: "pi_approval_requests", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "pi_automations", disposition: "keep", target: "Automation primary authority",
    source_of_truth: "pi_automations", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "pi_conversations", disposition: "keep", target: "Operator conversation",
    source_of_truth: "pi_conversations", retention: "R4_SENSITIVE", runtime_origin: "source_schema",
    live_rows: 25, delete_preconditions: []
  },
  {
    name: "pi_delegations", disposition: "migrate", target: "Automation standing order",
    source_of_truth: "pi_delegations until Automation parity", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "pi_guardian_alerts", disposition: "migrate", target: "Attention runtime alert",
    source_of_truth: "pi_guardian_alerts until Attention parity", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 6, delete_preconditions: []
  },
  {
    name: "pi_guardian_decisions", disposition: "keep", target: "Evidence: deterministic guardian decision",
    source_of_truth: "pi_guardian_decisions", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 65, delete_preconditions: []
  },
  {
    name: "pi_guardian_event_inbox", disposition: "keep", target: "Guardian intake Evidence",
    source_of_truth: "pi_guardian_event_inbox", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 1870, delete_preconditions: []
  },
  {
    name: "pi_guardian_watchdog_status", disposition: "merge", target: "Automation scheduler cursor",
    source_of_truth: "pi_guardian_watchdog_status", retention: "R1_OPERATIONAL", runtime_origin: "source_schema",
    live_rows: 1, delete_preconditions: []
  },
  {
    name: "pi_heartbeat_controls", disposition: "merge", target: "Automation pause/resume control",
    source_of_truth: "pi_heartbeat_controls", retention: "R2_DURABLE", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "pi_heartbeat_events", disposition: "merge", target: "Automation execution Evidence",
    source_of_truth: "pi_heartbeat_events; not a core Run", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "pi_heartbeat_runs", disposition: "merge", target: "Automation execution audit",
    source_of_truth: "pi_heartbeat_runs; not a core Run", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "pi_issue_completion_watch_items", disposition: "merge", target: "Automation execution Evidence",
    source_of_truth: "pi_issue_completion_watch_items", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "pi_issue_completion_watches", disposition: "migrate", target: "Automation completion watch",
    source_of_truth: "pi_issue_completion_watches until Automation parity", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "pi_mcp_capabilities", disposition: "keep", target: "Capability registry",
    source_of_truth: "pi_mcp_capabilities", retention: "R2_DURABLE", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "pi_mcp_servers", disposition: "keep", target: "Capability registry",
    source_of_truth: "pi_mcp_servers", retention: "R4_SENSITIVE", runtime_origin: "source_schema",
    live_rows: 4, delete_preconditions: []
  },
  {
    name: "pi_memory_items", disposition: "keep", target: "Supporting knowledge store",
    source_of_truth: "pi_memory_items", retention: "R4_SENSITIVE", runtime_origin: "source_schema",
    live_rows: 1, delete_preconditions: []
  },
  {
    name: "pi_notification_intents", disposition: "merge", target: "Attention delivery projection",
    source_of_truth: "pi_notification_intents", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 312, delete_preconditions: []
  },
  {
    name: "pi_notification_preferences", disposition: "keep", target: "Notification policy",
    source_of_truth: "pi_notification_preferences", retention: "R2_DURABLE", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "pi_recovery_attempts", disposition: "merge", target: "Run recovery Evidence",
    source_of_truth: "pi_recovery_attempts", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 5, delete_preconditions: []
  },
  {
    name: "pi_reports", disposition: "merge", target: "Evidence and Handoff projection",
    source_of_truth: "pi_reports; underlying facts remain authoritative", retention: "R0_DERIVED", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "pi_run_group_items", disposition: "merge", target: "Run grouped projection",
    source_of_truth: "pi_run_group_items", retention: "R1_OPERATIONAL", runtime_origin: "source_schema",
    live_rows: 46, delete_preconditions: []
  },
  {
    name: "pi_run_groups", disposition: "merge", target: "Run grouped projection",
    source_of_truth: "pi_run_groups", retention: "R1_OPERATIONAL", runtime_origin: "source_schema",
    live_rows: 5, delete_preconditions: []
  },
  {
    name: "pi_skill_intent_audits", disposition: "keep", target: "Evidence: capability selection audit",
    source_of_truth: "pi_skill_intent_audits", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 383, delete_preconditions: []
  },
  {
    name: "project_holds", disposition: "merge", target: "Attention plus project execution gate",
    source_of_truth: "project_holds", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "project_pi_policies", disposition: "keep", target: "Deterministic permission policy",
    source_of_truth: "project_pi_policies", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 38, delete_preconditions: []
  },
  {
    name: "project_pi_settings", disposition: "migrate", target: "Project policy and Automation settings",
    source_of_truth: "project_pi_settings until field parity", retention: "R2_DURABLE", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "projects", disposition: "keep", target: "Project scope authority",
    source_of_truth: "projects", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 11, delete_preconditions: []
  },
  {
    name: "run_attempts", disposition: "keep", target: "Run Attempt authority",
    source_of_truth: "run_attempts", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "schema_migrations", disposition: "keep", target: "Storage migration ledger",
    source_of_truth: "schema_migrations", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 39, delete_preconditions: []
  },
  {
    name: "session_command_events", disposition: "merge", target: "Run or Evidence command facts",
    source_of_truth: "session_command_events", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "session_turn_references", disposition: "merge", target: "Evidence provenance refs",
    source_of_truth: "session_turn_references", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "sync_outbox", disposition: "keep", target: "Handoff external-delivery audit/outbox",
    source_of_truth: "sync_outbox", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 52, delete_preconditions: []
  },
  {
    name: "tracker_issue_links", disposition: "keep", target: "Tracker issue relation authority",
    source_of_truth: "tracker_issue_links", retention: "R2_DURABLE", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "tracker_project_mappings", disposition: "keep", target: "Tracker project mapping authority",
    source_of_truth: "tracker_project_mappings", retention: "R2_DURABLE", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "tracker_sync_cursors", disposition: "keep", target: "Tracker synchronization cursor",
    source_of_truth: "tracker_sync_cursors", retention: "R1_OPERATIONAL", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "tracker_sync_events", disposition: "keep", target: "Tracker synchronization audit",
    source_of_truth: "tracker_sync_events", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "uploads", disposition: "keep", target: "Evidence artifact store",
    source_of_truth: "uploads", retention: "R4_SENSITIVE", runtime_origin: "source_schema",
    live_rows: 54, delete_preconditions: []
  },
  {
    name: "work_events", disposition: "keep", target: "Work ledger audit",
    source_of_truth: "work_events", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "work_relations", disposition: "keep", target: "Work dependency and hierarchy relations",
    source_of_truth: "work_relations", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
  {
    name: "works", disposition: "keep", target: "Work shadow ledger during migration",
    source_of_truth: "issues until Work authority cutover", retention: "R3_AUDIT", runtime_origin: "source_schema",
    live_rows: 0, delete_preconditions: []
  },
] as const;

export const API_ROUTE_FAMILIES = [
  { id: "assistant-runtime", disposition: "keep", target: "Operator conversation and supporting memory/config", source_of_truth: "pi_conversations, pi_agents, pi_memory_items" },
  { id: "attention", disposition: "merge", target: "Attention projections with deterministic resolution gates", source_of_truth: "attention_inbox_items and current Guardian/Approval carriers" },
  { id: "automation", disposition: "migrate", target: "Automation API with legacy cron/delegation compatibility", source_of_truth: "pi_automations plus legacy cron_tasks/pi_delegations" },
  { id: "capability-policy", disposition: "keep", target: "Capability registry and deterministic permission policy", source_of_truth: "tool/MCP registries and project_pi_policies" },
  { id: "evidence-handoff", disposition: "merge", target: "Evidence/Handoff read models and audited action requests", source_of_truth: "issue/pi audit authorities plus derived Handoff" },
  { id: "integration-intake-delivery", disposition: "keep", target: "Audited intake and external delivery adapters", source_of_truth: "external_events/external_links/outbox authorities" },
  { id: "project-scope", disposition: "keep", target: "Project/local control-plane scope", source_of_truth: "projects and scoped settings" },
  { id: "run-session-drilldown", disposition: "merge", target: "Run with provider Session drill-down", source_of_truth: "issue_runs; agent_sessions remains a reference" },
  { id: "system-observability", disposition: "keep", target: "Local runtime observability/control", source_of_truth: "live process, config, logs and event bus" },
  { id: "work-ledger", disposition: "keep", target: "Work ledger compatibility API", source_of_truth: "issues remains authoritative" },
] as const;

export const API_ROUTE_DISPOSITIONS = [
  { method: "GET", path: "/api/automations", family: "automation" },
  { method: "GET", path: "/api/automations/:id", family: "automation" },
  { method: "PATCH", path: "/api/automations/:id", family: "automation" },
  { method: "PATCH", path: "/api/automations/:id/trigger", family: "automation" },
  { method: "POST", path: "/api/automations", family: "automation" },
  { method: "POST", path: "/api/automations/:id/run-now", family: "automation" },
  { method: "POST", path: "/api/automations/:id/status", family: "automation" },
  { method: "GET", path: "/api/command-center/attention/:id", family: "attention" },
  { method: "GET", path: "/api/command-center/summary", family: "attention" },
  { method: "POST", path: "/api/command-center/attention/:id/actions/:action", family: "attention" },
  { method: "GET", path: "/api/event-summaries", family: "system-observability" },
  { method: "GET", path: "/api/evidence", family: "evidence-handoff" },
  { method: "GET", path: "/api/evidence/:id", family: "evidence-handoff" },
  { method: "GET", path: "/api/evidence/:id/artifacts/:index", family: "evidence-handoff" },
  { method: "GET", path: "/api/issues/:id/event-summaries", family: "system-observability" },
  { method: "GET", path: "/api/pi/approval-requests/:id", family: "attention" },
  { method: "GET", path: "/api/pi/connectors/diagnostics", family: "capability-policy" },
  { method: "POST", path: "/api/pi/connectors/:id/revoke", family: "capability-policy" },
  { method: "POST", path: "/api/pi/connectors/:id/test-connection", family: "capability-policy" },
  { method: "POST", path: "/api/handoffs/:id/reviews", family: "evidence-handoff" },
  { method: "POST", path: "/api/integrations/git/:provider/events", family: "integration-intake-delivery" },
  { method: "POST", path: "/api/integrations/git/:provider/resync", family: "integration-intake-delivery" },
  { method: "PUT", path: "/api/integrations/git/mappings", family: "integration-intake-delivery" },
  { method: "POST", path: "/api/integrations/trackers/:provider/events", family: "integration-intake-delivery" },
  { method: "POST", path: "/api/integrations/trackers/:provider/poll", family: "integration-intake-delivery" },
  { method: "PUT", path: "/api/integrations/trackers/:provider/links", family: "integration-intake-delivery" },
  { method: "PUT", path: "/api/integrations/trackers/mappings", family: "integration-intake-delivery" },
  { method: "POST", path: "/api/integrations/webhook/events", family: "integration-intake-delivery" },
  { method: "GET", path: "/api/runs", family: "run-session-drilldown" },
  { method: "GET", path: "/api/runs/:id", family: "run-session-drilldown" },
  { method: "POST", path: "/api/runs/:id/actions/:action", family: "run-session-drilldown" },
  { method: "GET", path: "/api/work-relations", family: "work-ledger" },
  { method: "GET", path: "/api/works", family: "work-ledger" },
  { method: "GET", path: "/api/works/:id", family: "work-ledger" },
  { method: "GET", path: "/api/works/:id/relations", family: "work-ledger" },
  { method: "GET", path: "/api/works/:id/timeline", family: "work-ledger" },
  { method: "PATCH", path: "/api/works/:id", family: "work-ledger" },
  { method: "POST", path: "/api/works", family: "work-ledger" },
  { method: "POST", path: "/api/works/:id/actions/:action", family: "work-ledger" },
  { method: "GET", path: "/api/agent-profiles", family: "project-scope" },
  { method: "POST", path: "/api/agent-profiles", family: "project-scope" },
  { method: "DELETE", path: "/api/agent-profiles/:id", family: "project-scope" },
  { method: "PATCH", path: "/api/agent-profiles/:id", family: "project-scope" },
  { method: "GET", path: "/api/capabilities", family: "system-observability" },
  { method: "POST", path: "/api/codex/approvals/:id/resolve", family: "run-session-drilldown" },
  { method: "GET", path: "/api/codex/models", family: "system-observability" },
  { method: "POST", path: "/api/commands", family: "run-session-drilldown" },
  { method: "GET", path: "/api/cron-tasks", family: "automation" },
  { method: "POST", path: "/api/cron-tasks", family: "automation" },
  { method: "DELETE", path: "/api/cron-tasks/:id", family: "automation" },
  { method: "PATCH", path: "/api/cron-tasks/:id", family: "automation" },
  { method: "GET", path: "/api/events", family: "system-observability" },
  { method: "GET", path: "/api/external-events", family: "integration-intake-delivery" },
  { method: "GET", path: "/api/external-events/:id", family: "integration-intake-delivery" },
  { method: "POST", path: "/api/external-events/:id/create-issue", family: "integration-intake-delivery" },
  { method: "GET", path: "/api/handoffs", family: "evidence-handoff" },
  { method: "GET", path: "/api/handoffs/:id", family: "evidence-handoff" },
  { method: "GET", path: "/api/im-reply-drafts", family: "integration-intake-delivery" },
  { method: "GET", path: "/api/im-reply-drafts/:id", family: "integration-intake-delivery" },
  { method: "POST", path: "/api/im-reply-drafts/:id/approve", family: "integration-intake-delivery" },
  { method: "POST", path: "/api/im-reply-drafts/:id/reject", family: "integration-intake-delivery" },
  { method: "POST", path: "/api/integrations/feishu/events", family: "integration-intake-delivery" },
  { method: "GET", path: "/api/integrations/feishu/settings", family: "integration-intake-delivery" },
  { method: "PUT", path: "/api/integrations/feishu/settings", family: "integration-intake-delivery" },
  { method: "GET", path: "/api/issue-templates", family: "work-ledger" },
  { method: "POST", path: "/api/issue-templates", family: "work-ledger" },
  { method: "DELETE", path: "/api/issue-templates/:id", family: "work-ledger" },
  { method: "GET", path: "/api/issue-templates/:id", family: "work-ledger" },
  { method: "PATCH", path: "/api/issue-templates/:id", family: "work-ledger" },
  { method: "GET", path: "/api/issues", family: "work-ledger" },
  { method: "POST", path: "/api/issues", family: "work-ledger" },
  { method: "DELETE", path: "/api/issues/:id", family: "work-ledger" },
  { method: "GET", path: "/api/issues/:id", family: "work-ledger" },
  { method: "PATCH", path: "/api/issues/:id", family: "work-ledger" },
  { method: "POST", path: "/api/issues/:id/cancel", family: "work-ledger" },
  { method: "POST", path: "/api/issues/:id/comments", family: "work-ledger" },
  { method: "POST", path: "/api/issues/:id/enqueue", family: "work-ledger" },
  { method: "GET", path: "/api/issues/:id/events", family: "work-ledger" },
  { method: "POST", path: "/api/issues/:id/retry", family: "work-ledger" },
  { method: "GET", path: "/api/issues/:id/runs", family: "work-ledger" },
  { method: "GET", path: "/api/issues/:id/supervisor", family: "evidence-handoff" },
  { method: "POST", path: "/api/issues/:id/verification", family: "evidence-handoff" },
  { method: "POST", path: "/api/issues/:id/verifier-report", family: "evidence-handoff" },
  { method: "GET", path: "/api/notifications", family: "attention" },
  { method: "POST", path: "/api/notifications/:id/read", family: "attention" },
  { method: "GET", path: "/api/pi/action-proposals", family: "evidence-handoff" },
  { method: "POST", path: "/api/pi/action-proposals", family: "evidence-handoff" },
  { method: "GET", path: "/api/pi/action-proposals/:id", family: "evidence-handoff" },
  { method: "POST", path: "/api/pi/action-proposals/:id/approve", family: "evidence-handoff" },
  { method: "POST", path: "/api/pi/action-proposals/:id/reject", family: "evidence-handoff" },
  { method: "GET", path: "/api/pi/actions", family: "evidence-handoff" },
  { method: "GET", path: "/api/pi/actions/:id", family: "evidence-handoff" },
  { method: "POST", path: "/api/pi/actions/:id/approve", family: "evidence-handoff" },
  { method: "GET", path: "/api/pi/actions/:id/events", family: "evidence-handoff" },
  { method: "POST", path: "/api/pi/actions/:id/execute", family: "evidence-handoff" },
  { method: "POST", path: "/api/pi/actions/:id/reject", family: "evidence-handoff" },
  { method: "POST", path: "/api/pi/actions/:id/request-changes", family: "evidence-handoff" },
  { method: "POST", path: "/api/pi/actions/:id/snooze", family: "evidence-handoff" },
  { method: "GET", path: "/api/pi/activity", family: "evidence-handoff" },
  { method: "GET", path: "/api/pi/agents", family: "assistant-runtime" },
  { method: "GET", path: "/api/pi/agents/:id", family: "assistant-runtime" },
  { method: "PATCH", path: "/api/pi/agents/:id", family: "assistant-runtime" },
  { method: "GET", path: "/api/pi/agents/:id/runtime-prompt", family: "assistant-runtime" },
  { method: "GET", path: "/api/pi/approval-requests", family: "attention" },
  { method: "POST", path: "/api/pi/approval-requests/:id/resolve", family: "attention" },
  { method: "GET", path: "/api/pi/attention-inbox/context-bundles", family: "attention" },
  { method: "GET", path: "/api/pi/attention-inbox/context-bundles/:id", family: "attention" },
  { method: "GET", path: "/api/pi/attention-inbox/intake-runs", family: "attention" },
  { method: "GET", path: "/api/pi/attention-inbox/intake-runs/:id", family: "attention" },
  { method: "GET", path: "/api/pi/attention-inbox/items", family: "attention" },
  { method: "GET", path: "/api/pi/attention-inbox/items/:id", family: "attention" },
  { method: "PATCH", path: "/api/pi/attention-inbox/items/:id", family: "attention" },
  { method: "POST", path: "/api/pi/attention-inbox/items/:id/domain-skill", family: "attention" },
  { method: "POST", path: "/api/pi/attention-inbox/items/:id/ignore", family: "attention" },
  { method: "POST", path: "/api/pi/attention-inbox/items/:id/reintake", family: "attention" },
  { method: "GET", path: "/api/pi/attention-inbox/raw-events", family: "attention" },
  { method: "GET", path: "/api/pi/attention-inbox/raw-events/:id", family: "attention" },
  { method: "GET", path: "/api/pi/audit-events", family: "evidence-handoff" },
  { method: "GET", path: "/api/pi/automations", family: "automation" },
  { method: "POST", path: "/api/pi/automations", family: "automation" },
  { method: "GET", path: "/api/pi/automations/:id", family: "automation" },
  { method: "PATCH", path: "/api/pi/automations/:id", family: "automation" },
  { method: "GET", path: "/api/pi/automations/runnable", family: "automation" },
  { method: "GET", path: "/api/pi/connectors", family: "capability-policy" },
  { method: "GET", path: "/api/pi/connectors/health", family: "capability-policy" },
  { method: "GET", path: "/api/pi/conversations", family: "assistant-runtime" },
  { method: "POST", path: "/api/pi/conversations", family: "assistant-runtime" },
  { method: "GET", path: "/api/pi/conversations/:id", family: "assistant-runtime" },
  { method: "POST", path: "/api/pi/conversations/:id/interrupt", family: "assistant-runtime" },
  { method: "POST", path: "/api/pi/conversations/:id/messages", family: "assistant-runtime" },
  { method: "GET", path: "/api/pi/delegations", family: "automation" },
  { method: "POST", path: "/api/pi/delegations", family: "automation" },
  { method: "GET", path: "/api/pi/delegations/:id", family: "automation" },
  { method: "PATCH", path: "/api/pi/delegations/:id", family: "automation" },
  { method: "POST", path: "/api/pi/delegations/:id/expire", family: "automation" },
  { method: "POST", path: "/api/pi/delegations/:id/pause", family: "automation" },
  { method: "POST", path: "/api/pi/delegations/:id/resume", family: "automation" },
  { method: "GET", path: "/api/pi/guardian/alerts", family: "attention" },
  { method: "POST", path: "/api/pi/guardian/alerts/:id/ack", family: "attention" },
  { method: "POST", path: "/api/pi/guardian/digest/flush", family: "attention" },
  { method: "GET", path: "/api/pi/guardian/notification-intents", family: "evidence-handoff" },
  { method: "GET", path: "/api/pi/guardian/preferences", family: "capability-policy" },
  { method: "POST", path: "/api/pi/guardian/preferences", family: "capability-policy" },
  { method: "POST", path: "/api/pi/guardian/preferences/:id/disable", family: "capability-policy" },
  { method: "GET", path: "/api/pi/guardian/run-groups", family: "evidence-handoff" },
  { method: "GET", path: "/api/pi/guardian/run-groups/:id", family: "evidence-handoff" },
  { method: "GET", path: "/api/pi/heartbeat-timeline", family: "automation" },
  { method: "GET", path: "/api/pi/issue-completion-watches", family: "automation" },
  { method: "GET", path: "/api/pi/issue-completion-watches/:id", family: "automation" },
  { method: "POST", path: "/api/pi/issue-completion-watches/:id/cancel", family: "automation" },
  { method: "GET", path: "/api/pi/maintenance/stale-pending-actions", family: "attention" },
  { method: "POST", path: "/api/pi/maintenance/stale-pending-actions/apply", family: "attention" },
  { method: "GET", path: "/api/pi/mcp/capabilities", family: "capability-policy" },
  { method: "GET", path: "/api/pi/mcp/capabilities/:id", family: "capability-policy" },
  { method: "PATCH", path: "/api/pi/mcp/capabilities/:id", family: "capability-policy" },
  { method: "GET", path: "/api/pi/mcp/discovery/results", family: "capability-policy" },
  { method: "POST", path: "/api/pi/mcp/discovery/scan", family: "capability-policy" },
  { method: "GET", path: "/api/pi/mcp/discovery/sources", family: "capability-policy" },
  { method: "POST", path: "/api/pi/mcp/servers", family: "capability-policy" },
  { method: "DELETE", path: "/api/pi/mcp/servers/:id", family: "capability-policy" },
  { method: "PATCH", path: "/api/pi/mcp/servers/:id", family: "capability-policy" },
  { method: "POST", path: "/api/pi/mcp/servers/:id/introspect", family: "capability-policy" },
  { method: "GET", path: "/api/pi/memory", family: "assistant-runtime" },
  { method: "POST", path: "/api/pi/memory", family: "assistant-runtime" },
  { method: "DELETE", path: "/api/pi/memory/:id", family: "assistant-runtime" },
  { method: "PATCH", path: "/api/pi/memory/:id", family: "assistant-runtime" },
  { method: "POST", path: "/api/pi/memory/:id/approve", family: "assistant-runtime" },
  { method: "POST", path: "/api/pi/memory/:id/disable", family: "assistant-runtime" },
  { method: "POST", path: "/api/pi/memory/:id/forget", family: "assistant-runtime" },
  { method: "POST", path: "/api/pi/memory/:id/pin", family: "assistant-runtime" },
  { method: "POST", path: "/api/pi/memory/:id/promote", family: "assistant-runtime" },
  { method: "POST", path: "/api/pi/memory/batch", family: "assistant-runtime" },
  { method: "POST", path: "/api/pi/memory/candidates", family: "assistant-runtime" },
  { method: "GET", path: "/api/pi/memory/digest", family: "assistant-runtime" },
  { method: "POST", path: "/api/pi/oauth/openai-codex/login", family: "capability-policy" },
  { method: "POST", path: "/api/pi/oauth/openai-codex/logout", family: "capability-policy" },
  { method: "GET", path: "/api/pi/oauth/openai-codex/status", family: "capability-policy" },
  { method: "GET", path: "/api/pi/provider-settings", family: "capability-policy" },
  { method: "GET", path: "/api/pi/provider-settings/catalog", family: "capability-policy" },
  { method: "PUT", path: "/api/pi/provider-settings/:id", family: "capability-policy" },
  { method: "POST", path: "/api/pi/provider-settings/:id/test-connection", family: "capability-policy" },
  { method: "GET", path: "/api/pi/reports", family: "evidence-handoff" },
  { method: "GET", path: "/api/pi/reports/:id", family: "evidence-handoff" },
  { method: "POST", path: "/api/pi/reports/generate", family: "evidence-handoff" },
  { method: "GET", path: "/api/pi/skills", family: "capability-policy" },
  { method: "GET", path: "/api/pi/skills/:id", family: "capability-policy" },
  { method: "POST", path: "/api/pi/skills/:id/domain-runs", family: "capability-policy" },
  { method: "POST", path: "/api/pi/skills/:id/intake-runs", family: "capability-policy" },
  { method: "GET", path: "/api/pi/skills/domain-runs", family: "capability-policy" },
  { method: "GET", path: "/api/pi/skills/intake-runs", family: "capability-policy" },
  { method: "GET", path: "/api/pi/source-policies", family: "capability-policy" },
  { method: "POST", path: "/api/pi/source-policies", family: "capability-policy" },
  { method: "PATCH", path: "/api/pi/source-policies/automations/:id", family: "capability-policy" },
  { method: "GET", path: "/api/pi/tool-providers", family: "capability-policy" },
  { method: "GET", path: "/api/pi/tools", family: "capability-policy" },
  { method: "GET", path: "/api/pi/tools/:id", family: "capability-policy" },
  { method: "POST", path: "/api/pi/tools/:id/call", family: "capability-policy" },
  { method: "GET", path: "/api/projects", family: "project-scope" },
  { method: "PATCH", path: "/api/projects", family: "project-scope" },
  { method: "POST", path: "/api/projects", family: "project-scope" },
  { method: "DELETE", path: "/api/projects/:id", family: "project-scope" },
  { method: "GET", path: "/api/projects/:id", family: "project-scope" },
  { method: "PATCH", path: "/api/projects/:id", family: "project-scope" },
  { method: "POST", path: "/api/projects/:id/hold/resume", family: "project-scope" },
  { method: "POST", path: "/api/projects/:id/loop/start", family: "project-scope" },
  { method: "GET", path: "/api/projects/:id/loop/status", family: "project-scope" },
  { method: "POST", path: "/api/projects/:id/loop/stop", family: "project-scope" },
  { method: "GET", path: "/api/projects/:id/pi-policy", family: "capability-policy" },
  { method: "PATCH", path: "/api/projects/:id/pi-policy", family: "capability-policy" },
  { method: "GET", path: "/api/projects/:id/pi-settings", family: "capability-policy" },
  { method: "PATCH", path: "/api/projects/:id/pi-settings", family: "capability-policy" },
  { method: "GET", path: "/api/projects/:id/pi/heartbeat/diagnostics", family: "automation" },
  { method: "POST", path: "/api/projects/:id/pi/heartbeat/pause", family: "automation" },
  { method: "POST", path: "/api/projects/:id/pi/heartbeat/resume", family: "automation" },
  { method: "POST", path: "/api/projects/:id/pi/heartbeat/run-once", family: "automation" },
  { method: "GET", path: "/api/projects/:id/pi/issue-state", family: "project-scope" },
  { method: "POST", path: "/api/projects/:id/pi/pause", family: "automation" },
  { method: "POST", path: "/api/projects/:id/pi/resume", family: "automation" },
  { method: "POST", path: "/api/projects/:id/pi/run-once", family: "automation" },
  { method: "GET", path: "/api/projects/:id/references/search", family: "project-scope" },
  { method: "POST", path: "/api/projects/sync/codex", family: "project-scope" },
  { method: "GET", path: "/api/runner/settings", family: "capability-policy" },
  { method: "PUT", path: "/api/runner/settings", family: "capability-policy" },
  { method: "GET", path: "/api/session-images", family: "integration-intake-delivery" },
  { method: "GET", path: "/api/sessions", family: "run-session-drilldown" },
  { method: "POST", path: "/api/sessions", family: "run-session-drilldown" },
  { method: "GET", path: "/api/sessions/:id", family: "run-session-drilldown" },
  { method: "POST", path: "/api/sessions/:id/interrupt", family: "run-session-drilldown" },
  { method: "POST", path: "/api/sessions/:id/messages", family: "run-session-drilldown" },
  { method: "GET", path: "/api/sessions/preferences", family: "run-session-drilldown" },
  { method: "GET", path: "/api/sync-outbox", family: "integration-intake-delivery" },
  { method: "POST", path: "/api/sync-outbox/dispatch", family: "integration-intake-delivery" },
  { method: "GET", path: "/api/system/doctor", family: "system-observability" },
  { method: "GET", path: "/api/system/logs", family: "system-observability" },
  { method: "POST", path: "/api/system/restart", family: "system-observability" },
  { method: "GET", path: "/api/system/status", family: "system-observability" },
  { method: "GET", path: "/api/uploads/:id/content", family: "integration-intake-delivery" },
  { method: "POST", path: "/api/uploads/images", family: "integration-intake-delivery" },
  { method: "GET", path: "/api/usage/codex", family: "system-observability" },
] as const;

export const PAGE_SURFACES = [
  {
    id: "assistant-runtime", disposition: "keep", target: "Operator conversation and supporting memory/config",
    page_ids: ["pi-chat", "pi-overview", "pi-memory"],
    source_files: ["frontend/src/pages/PiAgentSettingsPanel.jsx", "frontend/src/pages/PiChat.jsx", "frontend/src/pages/PiChatComposerMeta.jsx", "frontend/src/pages/PiMemoryPanel.jsx"]
  },
  {
    id: "attention", disposition: "merge", target: "Attention projections with deterministic resolution gates",
    page_ids: ["pi-inbox", "attention-inbox"],
    source_files: ["frontend/src/pages/AttentionInbox.jsx"]
  },
  {
    id: "automation", disposition: "migrate", target: "Automation API with legacy cron/delegation compatibility",
    page_ids: ["cron", "pi-automations"],
    source_files: ["frontend/src/pages/Automations.jsx", "frontend/src/pages/AutomationsRuntimePanel.jsx", "frontend/src/pages/Cron.jsx"]
  },
  {
    id: "capability-policy", disposition: "keep", target: "Capability registry and deterministic permission policy",
    page_ids: ["settings", "pi-connectors", "pi-skills", "pi-policies"],
    source_files: ["frontend/src/pages/AssistantSettingsPlaceholders.jsx", "frontend/src/pages/AssistantSettingsSections.jsx", "frontend/src/pages/ConnectorDiagnosticsPanel.jsx", "frontend/src/pages/FeishuSettingsPanel.jsx", "frontend/src/pages/NotificationSettingsPanel.jsx", "frontend/src/pages/PermissionsSettingsPanel.jsx", "frontend/src/pages/PiMcpManagementPanel.jsx", "frontend/src/pages/ProviderAvailabilityPanel.jsx", "frontend/src/pages/RunnerSettingsPanel.jsx", "frontend/src/pages/Settings.jsx", "frontend/src/pages/SettingsChrome.jsx", "frontend/src/pages/SkillsRuntimePanel.jsx", "frontend/src/pages/SourcePoliciesPanel.jsx"]
  },
  {
    id: "evidence-handoff", disposition: "merge", target: "Evidence/Handoff read models and audited action requests",
    page_ids: ["handoffs", "pi-activity", "pi-approvals"],
    source_files: ["frontend/src/pages/ActivityTimelinePanel.jsx", "frontend/src/pages/Handoffs.jsx"]
  },
  {
    id: "project-scope", disposition: "keep", target: "Project/local control-plane scope",
    page_ids: ["projects"],
    source_files: ["frontend/src/pages/ProjectHoldNotice.jsx", "frontend/src/pages/Projects.jsx"]
  },
  {
    id: "run-session-drilldown", disposition: "merge", target: "Run with provider Session drill-down",
    page_ids: ["runs", "sessions"],
    source_files: ["frontend/src/pages/Runs.jsx", "frontend/src/pages/Sessions.jsx"]
  },
  {
    id: "system-observability", disposition: "keep", target: "Local runtime observability/control",
    page_ids: ["dashboard"],
    source_files: ["frontend/src/pages/Dashboard.jsx"]
  },
  {
    id: "work-ledger", disposition: "keep", target: "Work ledger compatibility API",
    page_ids: ["issues", "issue-detail", "work-board", "work-detail"],
    source_files: ["frontend/src/pages/IssueCard.jsx", "frontend/src/pages/IssueCardMoreActions.jsx", "frontend/src/pages/IssueDetail.jsx", "frontend/src/pages/Issues.jsx", "frontend/src/pages/IssueSupervisorPanel.jsx", "frontend/src/pages/IssueTemplatesPanel.jsx", "frontend/src/pages/WorkBoard.jsx", "frontend/src/pages/WorkDetail.jsx"]
  },
] as const;

export const SCHEDULER_DISPOSITIONS = [
  { id: "startup-recovery", disposition: "keep", target: "Run recovery", entrypoint: "recoverInProgressIssues", source_file: "backend-ts/src/main.ts" },
  { id: "startup-completion-watch-sweep", disposition: "merge", target: "Automation completion-watch recovery", entrypoint: "sweepActivePiIssueCompletionWatches", source_file: "backend-ts/src/main.ts" },
  { id: "project-execution-loop", disposition: "keep", target: "Work queue to ordered Run attempts", entrypoint: "startProjectLoop / runProjectLoopOnce", source_file: "backend-ts/src/runner/projectLoopManager.ts" },
  { id: "auto-manage-timer", disposition: "keep", target: "Single local scheduler infrastructure", entrypoint: "createPiAutoManageScheduler", source_file: "backend-ts/src/runner/piAutoManageScheduler.ts" },
  { id: "issue-supervisor-scan", disposition: "merge", target: "Run recovery Evidence and Attention", entrypoint: "runPiIssueSupervisorSchedulerOnce", source_file: "backend-ts/src/runner/piAutoManageScheduler.ts" },
  { id: "legacy-cron-dispatch", disposition: "migrate", target: "Automation trigger/definition", entrypoint: "runDueCronTasks", source_file: "backend-ts/src/runner/piAutoManageScheduler.ts" },
  { id: "automation-dispatch", disposition: "keep", target: "Automation execution", entrypoint: "runDuePiAutomations", source_file: "backend-ts/src/runner/piAutoManageScheduler.ts" },
  { id: "delegation-heartbeat", disposition: "migrate", target: "Automation standing-order execution", entrypoint: "runDelegationHeartbeatsOnce", source_file: "backend-ts/src/runner/piAutoManageScheduler.ts" },
  { id: "provider-terminal-reconcile", disposition: "merge", target: "Run terminal Evidence", entrypoint: "signalOpenRunTerminalProviderErrors", source_file: "backend-ts/src/runner/piAutoManageScheduler.ts" },
  { id: "guardian-decision-and-action", disposition: "merge", target: "Attention/Evidence with deterministic gate", entrypoint: "drainGuardianDecisionOrchestrator + dispatchApprovedGuardianActions", source_file: "backend-ts/src/runner/piAutoManageScheduler.ts" },
  { id: "digest-and-delivery", disposition: "merge", target: "Attention delivery projection", entrypoint: "runDigestFlushSchedulerOnce + queueReady*Notifications", source_file: "backend-ts/src/runner/piAutoManageScheduler.ts" },
  { id: "guardian-watchdog", disposition: "merge", target: "Attention runtime health", entrypoint: "runPiGuardianWatchdogOnce + missed-intent sweep", source_file: "backend-ts/src/runner/piAutoManageScheduler.ts" },
  { id: "issue-watchdog", disposition: "merge", target: "Work blocker Attention", entrypoint: "runAutoRunIssueWatchdogOnce", source_file: "backend-ts/src/runner/piAutoManageScheduler.ts" },
  { id: "pi-project-cycle", disposition: "merge", target: "Automation-triggered Work proposals", entrypoint: "runPiAutoManageCycle", source_file: "backend-ts/src/runner/piAutoManageScheduler.ts" },
] as const;

export const PI_MODULE_FAMILIES = [
  {
    id: "action-permission-gate", disposition: "keep", target: "Deterministic permission and external-effect gate", source_of_truth: "Action Proposal/Approval plus pi_action_events",
    source_files: ["backend-ts/src/pi/actionAudit.ts", "backend-ts/src/pi/actionEngine.ts", "backend-ts/src/pi/actionEnvelope.ts", "backend-ts/src/pi/actionGate.ts", "backend-ts/src/pi/actionGateRecovery.ts", "backend-ts/src/pi/actionRecordMetadata.ts", "backend-ts/src/pi/approvalFastAudit.ts", "backend-ts/src/pi/approvalFastPolicy.ts", "backend-ts/src/pi/approvalGrantScope.ts", "backend-ts/src/pi/approvalPolicyCache.ts", "backend-ts/src/pi/approvalRequestParser.ts", "backend-ts/src/pi/approvalSafetyPolicy.ts", "backend-ts/src/pi/authorizationScope.ts", "backend-ts/src/pi/nonIssueProposalActions.ts", "backend-ts/src/pi/runnerChatAuthorization.ts", "backend-ts/src/pi/sourcePermissionPolicy.ts", "backend-ts/src/pi/stalePendingActions.ts"]
  },
  {
    id: "automation", disposition: "migrate", target: "Automation execution pipeline", source_of_truth: "pi_automations; legacy heartbeats/watches are compatibility carriers",
    source_files: ["backend-ts/src/pi/automationRunner.ts", "backend-ts/src/pi/heartbeatActionExecution.ts", "backend-ts/src/pi/heartbeatOrchestrator.ts", "backend-ts/src/pi/heartbeatOrchestratorSupport.ts", "backend-ts/src/pi/heartbeatPlanner.ts", "backend-ts/src/pi/heartbeatSignals.ts", "backend-ts/src/pi/heartbeatTypes.ts", "backend-ts/src/pi/heartbeatVerificationPlanner.ts", "backend-ts/src/pi/issueCompletionWatchActions.ts", "backend-ts/src/pi/issueCompletionWatchEvaluator.ts", "backend-ts/src/pi/manualTrigger.ts"]
  },
  {
    id: "capability-connectors", disposition: "keep", target: "Capability and connector runtime", source_of_truth: "registered provider/tool manifests and audited calls",
    source_files: ["backend-ts/src/pi/browserConnectorHealth.ts", "backend-ts/src/pi/browserToolCall.ts", "backend-ts/src/pi/browserToolProvider.ts", "backend-ts/src/pi/builtinToolRegistry.ts", "backend-ts/src/pi/cliConnectorHealth.ts", "backend-ts/src/pi/cliConnectorManifest.ts", "backend-ts/src/pi/cliConnectorProvider.ts", "backend-ts/src/pi/cliConnectorToolCall.ts", "backend-ts/src/pi/cliRawEventSync.ts", "backend-ts/src/pi/cliToolRunner.ts", "backend-ts/src/pi/cliToolRunnerSupport.ts", "backend-ts/src/pi/httpToolCall.ts", "backend-ts/src/pi/httpToolProvider.ts", "backend-ts/src/pi/mcpActionTools.ts", "backend-ts/src/pi/mcpResourceRead.ts", "backend-ts/src/pi/mcpToolCall.ts", "backend-ts/src/pi/mcpToolDefinitions.ts", "backend-ts/src/pi/mcpToolProvider.ts", "backend-ts/src/pi/mcpTransport.ts", "backend-ts/src/pi/piRuntimeTools.ts", "backend-ts/src/pi/readOnlyRuntimeTools.ts", "backend-ts/src/pi/readOnlyToolInvocation.ts", "backend-ts/src/pi/repoReadActionTools.ts", "backend-ts/src/pi/repoReadActions.ts", "backend-ts/src/pi/toolCallAudit.ts", "backend-ts/src/pi/toolProviderEnvelope.ts", "backend-ts/src/pi/toolRegistrySnapshot.ts"]
  },
  {
    id: "guardian-attention", disposition: "merge", target: "Attention detection, routing and delivery", source_of_truth: "Guardian authorities projected into Attention",
    source_files: ["backend-ts/src/pi/attentionRouter.ts", "backend-ts/src/pi/digestFlushScheduler.ts", "backend-ts/src/pi/digestFormatter.ts", "backend-ts/src/pi/failurePatternCandidates.ts", "backend-ts/src/pi/failurePatterns.ts", "backend-ts/src/pi/guardianActionLease.ts", "backend-ts/src/pi/guardianAlertRetryPolicy.ts", "backend-ts/src/pi/guardianDecisionActionCandidates.ts", "backend-ts/src/pi/guardianDecisionActions.ts", "backend-ts/src/pi/guardianDecisionMerge.ts", "backend-ts/src/pi/guardianDecisionOrchestrator.ts", "backend-ts/src/pi/guardianDecisionRateLimit.ts", "backend-ts/src/pi/guardianEventIngest.ts", "backend-ts/src/pi/guardianFailureClassifier.ts", "backend-ts/src/pi/guardianMissedDigestFallback.ts", "backend-ts/src/pi/guardianMissedIntentDigest.ts", "backend-ts/src/pi/guardianMissedIntentSweep.ts", "backend-ts/src/pi/guardianSignals.ts", "backend-ts/src/pi/guardianWatchdog.ts", "backend-ts/src/pi/guardianWatchdogAlerts.ts", "backend-ts/src/pi/guardianWatchdogMaintenance.ts", "backend-ts/src/pi/imReplyOutboxDispatcher.ts", "backend-ts/src/pi/notificationCoordinator.ts", "backend-ts/src/pi/notificationPreferenceResolver.ts", "backend-ts/src/pi/notificationPreferenceService.ts"]
  },
  {
    id: "intake-context", disposition: "merge", target: "Attention intake and Evidence context", source_of_truth: "external events, context bundles and intake audit",
    source_files: ["backend-ts/src/pi/contextBundleBuilder.ts", "backend-ts/src/pi/contextPackTrace.ts", "backend-ts/src/pi/domainSkillRun.ts", "backend-ts/src/pi/eventRouter.ts", "backend-ts/src/pi/intakeSkillInput.ts", "backend-ts/src/pi/intakeSourcePolicy.ts", "backend-ts/src/pi/llmIntake.ts", "backend-ts/src/pi/manualSourcePull.ts"]
  },
  {
    id: "memory", disposition: "keep", target: "Supporting knowledge store", source_of_truth: "pi_memory_items",
    source_files: ["backend-ts/src/pi/memoryContext.ts", "backend-ts/src/pi/memoryLifecycle.ts", "backend-ts/src/pi/memoryPolicy.ts", "backend-ts/src/pi/memoryTools.ts"]
  },
  {
    id: "policy-role", disposition: "keep", target: "Deterministic policy and role selection", source_of_truth: "project policy plus static role contracts",
    source_files: ["backend-ts/src/pi/policyTypes.ts", "backend-ts/src/pi/roleProfileSelector.ts"]
  },
  {
    id: "reporting", disposition: "merge", target: "Evidence/Handoff reporting projections", source_of_truth: "underlying immutable facts remain authoritative",
    source_files: ["backend-ts/src/pi/nightRunSummary.ts", "backend-ts/src/pi/reportHealth.ts", "backend-ts/src/pi/reportIssueSummary.ts", "backend-ts/src/pi/reportSupervisorSummary.ts", "backend-ts/src/pi/reportUsage.ts", "backend-ts/src/pi/reports.ts", "backend-ts/src/pi/runGroupReportStatus.ts", "backend-ts/src/pi/runGroupService.ts"]
  },
  {
    id: "test-support", disposition: "keep", target: "Focused deterministic fixtures", source_of_truth: "test-only import graph",
    source_files: ["backend-ts/src/pi/issueSupervisorDecisionTestSupport.ts", "backend-ts/src/pi/issueSupervisorRecoveryFixtures.ts"]
  },
  {
    id: "verification-evidence", disposition: "keep", target: "Evidence production and verification policy", source_of_truth: "verification facts and Git/runtime inputs",
    source_files: ["backend-ts/src/pi/meaningfulProgress.ts", "backend-ts/src/pi/projectFindingActions.ts", "backend-ts/src/pi/projectFindings.ts", "backend-ts/src/pi/projectSnapshot.ts", "backend-ts/src/pi/repoContextPack.ts", "backend-ts/src/pi/verificationEvidence.ts", "backend-ts/src/pi/verificationPolicy.ts"]
  },
  {
    id: "work-run-orchestration", disposition: "merge", target: "Work/Run orchestration and recovery", source_of_truth: "issues and issue_runs authorities",
    source_files: ["backend-ts/src/pi/agentOrchestration.ts", "backend-ts/src/pi/agentOrchestrationActions.ts", "backend-ts/src/pi/agentOrchestrationPayloads.ts", "backend-ts/src/pi/failedRetryPolicy.ts", "backend-ts/src/pi/issueProposalContext.ts", "backend-ts/src/pi/issueStateManager.ts", "backend-ts/src/pi/issueStateRepairExecutor.ts", "backend-ts/src/pi/issueStateSnapshot.ts", "backend-ts/src/pi/issueStateVerification.ts", "backend-ts/src/pi/issueSupervisorActions.ts", "backend-ts/src/pi/issueSupervisorContext.ts", "backend-ts/src/pi/issueSupervisorContextSupport.ts", "backend-ts/src/pi/issueSupervisorDecision.ts", "backend-ts/src/pi/issueSupervisorDecisionFailure.ts", "backend-ts/src/pi/issueSupervisorRecovery.ts", "backend-ts/src/pi/issueSupervisorRecoveryAttemptRecorder.ts", "backend-ts/src/pi/issueSupervisorSignalCollector.ts", "backend-ts/src/pi/issueToolViews.ts", "backend-ts/src/pi/providerErrorParser.ts", "backend-ts/src/pi/providerErrorParserSupport.ts", "backend-ts/src/pi/providerOutageDiagnosis.ts", "backend-ts/src/pi/recoveryActionPlanner.ts", "backend-ts/src/pi/recoveryBudget.ts", "backend-ts/src/pi/recoveryDiagnosis.ts", "backend-ts/src/pi/runnerActionTools.ts", "backend-ts/src/pi/runnerActions.ts", "backend-ts/src/pi/runnerBatchTriageScope.ts", "backend-ts/src/pi/runnerIssueScheduleActions.ts", "backend-ts/src/pi/runnerIssueStateActions.ts", "backend-ts/src/pi/runnerNextTriageActions.ts", "backend-ts/src/pi/sessionObserver.ts", "backend-ts/src/pi/supervisorCommitments.ts", "backend-ts/src/pi/supervisorContextResolver.ts", "backend-ts/src/pi/supervisorControlContracts.ts", "backend-ts/src/pi/supervisorControlTools.ts", "backend-ts/src/pi/supervisorIntentRouter.ts", "backend-ts/src/pi/supervisorWorkPlanner.ts"]
  },
] as const;

export const MIGRATION_GATES = {
  source_of_truth: "第一个迁移发布前，现有 SQLite/API/Git authorities 保持唯一写 authority",
  dual_write: "默认禁止；只有独立 migration ADR、幂等键、逐字段 parity 与审计事件齐备后才能限时开启",
  dual_read: "只允许 shadow comparison；用户读取继续旧 authority，直到 parity 观察窗通过",
  rollback: "停止新写并恢复旧读；新 projection 必须能由旧 rows/events/Git 重建",
  final_delete: "consumer 引用归零、数据导出校验、备份恢复演练、观察窗、审计批准全部通过"
} as const;
