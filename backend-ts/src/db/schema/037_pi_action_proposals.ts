import type { SqlMigration } from "../migrations.ts";

export const piActionProposalsMigration: SqlMigration = {
  id: "037_pi_action_proposals",
  sql: `
create table if not exists pi_action_proposals (
  id text primary key,
  skill_run_id text not null default '',
  source_item_ids_json text not null default '[]',
  summary text not null default '',
  actions_json text not null default '[]',
  evidence_refs_json text not null default '[]',
  target_hints_json text not null default '[]',
  confidence real not null default 0,
  status text not null default 'proposed',
  decision_reason text not null default '',
  decided_by text not null default '',
  approved_by text not null default '',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index if not exists idx_pi_action_proposals_status
  on pi_action_proposals(status, created_at desc, id);

create index if not exists idx_pi_action_proposals_skill_run
  on pi_action_proposals(skill_run_id, created_at desc, id);
`
};
