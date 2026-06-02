import { baseSchemaMigration } from "./001_base_schema.ts";
import { agentSessionsRuntimeMigration } from "./002_agent_sessions_runtime.ts";
import { piRuntimeMigration } from "./003_pi_runtime.ts";
import { safeGoImportTablesMigration } from "./004_safe_go_import_tables.ts";
import { readPerformanceIndexesMigration } from "./005_read_performance_indexes.ts";
import { piActionGateAuditMigration } from "./006_pi_action_gate_audit.ts";

export const migrations = [
  baseSchemaMigration,
  agentSessionsRuntimeMigration,
  piRuntimeMigration,
  safeGoImportTablesMigration,
  readPerformanceIndexesMigration,
  piActionGateAuditMigration
];
