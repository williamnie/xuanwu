import type { SqlMigration } from "../migrations.ts";

/** Make the Qoder code agent selectable without overwriting a customized profile. */
export const builtinQoderExecutorProfileMigration: SqlMigration = {
  id: "078_builtin_qoder_executor_profile",
  sql: `
insert or ignore into agent_profiles (
  id, name, provider, model, reasoning_effort, approval_policy, sandbox,
  service_tier, default_instructions, skill_intents_json, plugin_intents_json,
  created_at, updated_at
) values
  ('xuanwu-provider-qoder', 'Qoder（本机配置）', 'qoder', '', '', '', '', '', '', '[]', '[]', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
`
};
