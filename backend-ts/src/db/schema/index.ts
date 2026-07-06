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
  intakeRunsMigration
];
