import type { SqlMigration } from "../migrations.ts";

export const skillsRegistryIntentsMigration: SqlMigration = {
  id: "009_skills_registry_intents",
  sql: `
alter table projects add column default_skill_policy_json text not null default '{}';
alter table issues add column required_skill_intents_json text not null default '[]';
alter table issues add column recommended_skill_intents_json text not null default '[]';
alter table issue_runs add column skill_intent_audit_json text not null default '{}';

create table if not exists pi_skill_intent_audits (
  id integer primary key autoincrement,
  issue_id integer not null default 0,
  issue_run_id text not null default '',
  expected_skill_intents_json text not null default '[]',
  used_skill_intents_json text not null default '[]',
  missing_skill_intents_json text not null default '[]',
  unauthorized_skill_intents_json text not null default '[]',
  allowed_skill_intents_json text not null default '[]',
  status text not null default 'ok',
  created_at text not null,
  foreign key(issue_id) references issues(id) on delete cascade
);

create index if not exists idx_pi_skill_intent_audits_issue
  on pi_skill_intent_audits(issue_id, id);
`
};
