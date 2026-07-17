import type { SqlMigration } from "../migrations.ts";

// Tracker sync reuses external_events/external_links for event provenance and
// sync_outbox for Handoff writes. These tables hold only routing, cursors and
// conflict checkpoints; they are not a second Issue or outbox authority.
export const trackerIssueSyncMigration: SqlMigration = {
  id: "048_tracker_issue_sync",
  sql: `
create table if not exists tracker_project_mappings (
  provider text not null,
  scope text not null,
  project_id text not null,
  created_at text not null,
  updated_at text not null,
  primary key (provider, scope),
  foreign key(project_id) references projects(id) on delete restrict
);

create table if not exists tracker_issue_links (
  provider text not null,
  external_id text not null,
  project_id text not null,
  issue_id integer not null,
  last_external_updated_at text not null default '',
  last_synced_issue_updated_at text not null default '',
  created_at text not null,
  updated_at text not null,
  primary key (provider, external_id),
  foreign key(project_id) references projects(id) on delete restrict,
  foreign key(issue_id) references issues(id) on delete restrict
);

create table if not exists tracker_sync_cursors (
  provider text not null,
  scope text not null,
  position text not null,
  updated_at text not null,
  primary key (provider, scope)
);

create table if not exists tracker_sync_events (
  id integer primary key autoincrement,
  provider text not null,
  external_id text not null,
  project_id text not null default '',
  issue_id integer not null default 0,
  action text not null,
  correlation_id text not null,
  detail_json text not null default '{}',
  created_at text not null
);

create index if not exists idx_tracker_issue_links_issue
  on tracker_issue_links(issue_id, provider, external_id);
create index if not exists idx_tracker_sync_events_target
  on tracker_sync_events(provider, external_id, id desc);
`
};
