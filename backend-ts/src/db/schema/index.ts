import { baseSchemaMigration } from "./001_base_schema.ts";
import { agentSessionsRuntimeMigration } from "./002_agent_sessions_runtime.ts";
import { piRuntimeMigration } from "./003_pi_runtime.ts";

export const migrations = [
  baseSchemaMigration,
  agentSessionsRuntimeMigration,
  piRuntimeMigration
];
