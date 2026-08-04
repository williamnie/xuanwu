import type { SqlMigration } from "../migrations.ts";

/**
 * Issue/Work routing uses agent_profile_id for an explicit provider override.
 * Seed stable provider-only profiles so a fresh installation can select Codex
 * or Claude without requiring users to understand that internal routing seam.
 */
export const builtinExecutorProfilesMigration: SqlMigration = {
  id: "068_builtin_executor_profiles",
  sql: `
insert or ignore into agent_profiles (
  id, name, provider, model, reasoning_effort, approval_policy, sandbox,
  service_tier, default_instructions, skill_intents_json, plugin_intents_json,
  created_at, updated_at
) values
  ('xuanwu-provider-codex', 'Codex（内置）', 'codex', 'codex-default', '', '', '', '', '', '[]', '[]', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('xuanwu-provider-claude', 'Claude Code（本机配置）', 'claude', '', '', '', '', '', '', '[]', '[]', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
`
};
