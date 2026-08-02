import { baseSchemaMigration } from "./001_base_schema.ts";
import { agentSessionsRuntimeMigration } from "./002_agent_sessions_runtime.ts";
import { piRuntimeMigration } from "./003_pi_runtime.ts";
import { safeGoImportTablesMigration } from "./004_safe_go_import_tables.ts";
import { readPerformanceIndexesMigration } from "./005_read_performance_indexes.ts";
import { piActionGateAuditMigration } from "./006_pi_action_gate_audit.ts";
import { piHeartbeatOrchestratorMigration } from "./007_pi_heartbeat_orchestrator.ts";
import { cronScheduleLayerMigration } from "./008_cron_schedule_layer.ts";
import { skillsRegistryIntentsMigration } from "./009_skills_registry_intents.ts";
import { mcpRegistryEnvelopeMigration } from "./010_mcp_registry_envelope.ts";
import { piReportsMigration } from "./011_pi_reports.ts";
import { piDelegationEnvelopeMigration } from "./012_pi_delegation_envelope.ts";
import { projectPiPolicyMigration } from "./013_project_pi_policy.ts";
import { cronTaskClaimsMigration } from "./014_cron_task_claims.ts";
import { piDelegationSkillIntentsMigration } from "./015_pi_delegation_skill_intents.ts";
import { piDelegationMcpAllowlistMigration } from "./016_pi_delegation_mcp_allowlist.ts";
import { projectPiPolicyAllowlistsMigration } from "./017_project_pi_policy_allowlists.ts";
import { notificationsMigration } from "./018_notifications.ts";
import { executionServiceTierMigration } from "./019_execution_service_tier.ts";
import { issueSupervisorRecoveryMigration } from "./020_issue_supervisor_recovery.ts";
import { externalEventsMigration } from "./021_external_events.ts";
import { externalLinksMigration } from "./022_external_links.ts";
import { imReplyOutboxMigration } from "./023_im_reply_outbox.ts";
import { imReplyOutboxDispatchMigration } from "./024_im_reply_outbox_dispatch.ts";
import { feishuConversationStateMigration } from "./025_feishu_conversation_state.ts";
import { feishuProjectSelectionMigration } from "./026_feishu_project_selection.ts";
import { piApprovalRequestsMigration } from "./027_pi_approval_requests.ts";
import { piGuardianRuntimeMigration } from "./028_pi_guardian_runtime.ts";
import { piIssueCompletionWatchesMigration } from "./029_pi_issue_completion_watches.ts";
import { removeLegacyNotificationSettingsMigration } from "./030_remove_legacy_notification_settings.ts";
import { clearFeishuPiConversationProjectsMigration } from "./031_clear_feishu_pi_conversation_projects.ts";
import { assistantToolRegistryMigration } from "./032_assistant_tool_registry.ts";
import { contextBundlesMigration } from "./033_context_bundles.ts";
import { intakeRunsMigration } from "./034_intake_runs.ts";
import { piAutomationsMigration } from "./035_pi_automations.ts";
import { piAutomationSchedulerMigration } from "./036_pi_automation_scheduler.ts";
import { piActionProposalsMigration } from "./037_pi_action_proposals.ts";
import { piMemoryStoreMetadataMigration } from "./038_pi_memory_store_metadata.ts";
import { piMcpDiscoveryMigration } from "./039_pi_mcp_discovery.ts";
import { eventSummaryProjectionMigration } from "./040_event_summary_projection.ts";
import { workLedgerSchemaMigration } from "./041_work_ledger_schema.ts";
import { runAttemptRelationsMigration } from "./042_run_attempt_relations.ts";
import { trackerUpdateOutboxMigration } from "./043_tracker_update_outbox.ts";
import { attentionCommandEventsMigration } from "./044_attention_command_events.ts";
import { automationModelMigration } from "./045_automation_model.ts";
import { automationSchedulerMigration } from "./046_automation_scheduler.ts";
import { gitProviderEventsMigration } from "./047_git_provider_events.ts";
import { trackerIssueSyncMigration } from "./048_tracker_issue_sync.ts";
import { automationExecutionLinksMigration } from "./049_automation_execution_links.ts";
import { automationWatchesMigration } from "./050_automation_watches.ts";
import { removeProductionFixturesMigration } from "./051_remove_production_fixtures.ts";
import { consolidatePiDecisionLayersMigration } from "./052_consolidate_pi_decision_layers.ts";
import { dropLegacyAutomationTablesMigration } from "./053_drop_legacy_automation_tables.ts";
import { compactEventSummaryProjectionMigration } from "./054_compact_event_summary_projection.ts";
import { collapsePiAgentsToSupervisorMigration } from "./055_collapse_pi_agents_to_supervisor.ts";
import { issueLogModeMigration } from "./056_issue_log_mode.ts";
import { issueDependencyAndRunGitBaselineMigration } from "./057_issue_dependency_and_run_git_baseline.ts";
import { dropIssueTemplatesMigration } from "./058_drop_issue_templates.ts";
import { piAutomaticTakeoverMigration } from "./059_pi_automatic_takeover.ts";
import { mcpApprovalPolicyMigration } from "./060_mcp_approval_policy.ts";
import { projectMandatoryTakeoverMigration } from "./061_project_mandatory_takeover.ts";
import { reusablePiMemoryMigration } from "./062_reusable_pi_memory.ts";
import { piOwnedIssueLifecycleMigration } from "./064_pi_owned_issue_lifecycle.ts";
import { piPersonaMigration } from "./063_pi_persona.ts";
import { unlimitedProjectRecoveryBudgetMigration } from "./065_unlimited_project_recovery_budget.ts";
import { piContextMemoryAuthorityMigration } from "./066_pi_context_memory_authority.ts";

export const migrations = [
  baseSchemaMigration,
  agentSessionsRuntimeMigration,
  piRuntimeMigration,
  safeGoImportTablesMigration,
  readPerformanceIndexesMigration,
  piActionGateAuditMigration,
  piHeartbeatOrchestratorMigration,
  cronScheduleLayerMigration,
  skillsRegistryIntentsMigration,
  mcpRegistryEnvelopeMigration,
  piReportsMigration,
  piDelegationEnvelopeMigration,
  projectPiPolicyMigration,
  cronTaskClaimsMigration,
  piDelegationSkillIntentsMigration,
  piDelegationMcpAllowlistMigration,
  projectPiPolicyAllowlistsMigration,
  notificationsMigration,
  executionServiceTierMigration,
  issueSupervisorRecoveryMigration,
  externalEventsMigration,
  externalLinksMigration,
  imReplyOutboxMigration,
  imReplyOutboxDispatchMigration,
  feishuConversationStateMigration,
  feishuProjectSelectionMigration,
  piApprovalRequestsMigration,
  piGuardianRuntimeMigration,
  piIssueCompletionWatchesMigration,
  removeLegacyNotificationSettingsMigration,
  clearFeishuPiConversationProjectsMigration,
  assistantToolRegistryMigration,
  contextBundlesMigration,
  intakeRunsMigration,
  piAutomationsMigration,
  piAutomationSchedulerMigration,
  piActionProposalsMigration,
  piMemoryStoreMetadataMigration,
  piMcpDiscoveryMigration,
  eventSummaryProjectionMigration,
  workLedgerSchemaMigration,
  runAttemptRelationsMigration,
  trackerUpdateOutboxMigration,
  attentionCommandEventsMigration,
  automationModelMigration,
  automationSchedulerMigration,
  gitProviderEventsMigration,
  trackerIssueSyncMigration,
  automationExecutionLinksMigration,
  automationWatchesMigration,
  removeProductionFixturesMigration,
  consolidatePiDecisionLayersMigration,
  dropLegacyAutomationTablesMigration,
  compactEventSummaryProjectionMigration,
  collapsePiAgentsToSupervisorMigration,
  issueLogModeMigration,
  issueDependencyAndRunGitBaselineMigration,
  dropIssueTemplatesMigration,
  piAutomaticTakeoverMigration,
  mcpApprovalPolicyMigration,
  projectMandatoryTakeoverMigration,
  reusablePiMemoryMigration,
  piPersonaMigration,
  piOwnedIssueLifecycleMigration,
  unlimitedProjectRecoveryBudgetMigration,
  piContextMemoryAuthorityMigration
];
