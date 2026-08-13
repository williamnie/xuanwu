import type { SqlMigration } from "../migrations.ts";

/** W1 additive storage. `{}` keeps legacy fallback/inheritance distinguishable. */
export const executionPolicyJsonMigration: SqlMigration = {
  id: "080_execution_policy_json",
  sql: `
alter table projects add column execution_policy_json text not null default '{}';
alter table agent_profiles add column execution_policy_json text not null default '{}';
`
};
