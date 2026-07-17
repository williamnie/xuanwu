import type { SqlMigration } from "../migrations.ts";

// Repository mapping is the only routing authority for inbound Git events.
// It is deliberately separate from projects.provider_config_json so provider
// delivery never changes a project's execution configuration.
export const gitProviderEventsMigration: SqlMigration = {
  id: "047_git_provider_events",
  sql: `
create table if not exists git_repo_mappings (
  provider text not null,
  repository text not null,
  project_id text not null,
  created_at text not null,
  updated_at text not null,
  primary key (provider, repository),
  foreign key(project_id) references projects(id) on delete restrict
);

create table if not exists git_repo_mapping_events (
  id integer primary key autoincrement,
  provider text not null,
  repository text not null,
  project_id text not null,
  action text not null,
  audit_json text not null,
  created_at text not null
);

create index if not exists idx_git_repo_mappings_project
  on git_repo_mappings(project_id, provider, repository);
create index if not exists idx_git_repo_mapping_events_repository
  on git_repo_mapping_events(provider, repository, id desc);
`
};
