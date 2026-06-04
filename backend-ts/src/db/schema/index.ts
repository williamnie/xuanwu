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
  projectPiPolicyAllowlistsMigration
];
