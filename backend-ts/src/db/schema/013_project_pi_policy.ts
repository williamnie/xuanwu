import type { SqlMigration } from "../migrations.ts";

const PROJECT_PI_POLICY_SQL = `
create table if not exists project_pi_policies (
  project_id text primary key,
  default_mode text not null default 'manual',
  timezone text not null default 'UTC',
  working_hours_json text not null default '{}',
  quiet_hours_json text not null default '{}',
  retry_policy_json text not null default '{"enabled":false,"max_attempts":0,"backoff_minutes":[]}',
  concurrency_policy_json text not null default '{"max_parallel_issues":1,"max_parallel_pi_cycles":1}',
  created_at text not null,
  updated_at text not null
);
`;

export const projectPiPolicyMigration: SqlMigration = {
  id: "013_project_pi_policy",
  sql: PROJECT_PI_POLICY_SQL,
  apply(sqlite) {
    sqlite.run(PROJECT_PI_POLICY_SQL);
  }
};
