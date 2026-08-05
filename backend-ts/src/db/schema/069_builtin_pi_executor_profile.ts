import type { SqlMigration } from "../migrations.ts";

/** Make the Pi code agent selectable on databases that already ran migration 068. */
export const builtinPiExecutorProfileMigration: SqlMigration = {
  id: "069_builtin_pi_executor_profile",
  sql: `
insert or ignore into agent_profiles (
  id, name, provider, model, reasoning_effort, approval_policy, sandbox,
  service_tier, default_instructions, skill_intents_json, plugin_intents_json,
  created_at, updated_at
) values
  ('xuanwu-provider-pi', 'Pi（本机配置）', 'pi-coding-agent', '', '', '', '', '', '', '[]', '[]', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
`
};
