import type { SqlMigration } from "../migrations.ts";

export const externalLinksMigration: SqlMigration = {
  id: "022_external_links",
  sql: `
create table if not exists external_links (
  id integer primary key autoincrement,
  external_event_id integer not null default 0,
  source text not null,
  external_id text not null default '',
  external_type text not null default '',
  project_id text not null default '',
  issue_id integer not null default 0,
  conversation_id text not null default '',
  loop_run_id text not null default '',
  relationship text not null default 'related',
  created_at text not null,
  updated_at text not null
);

-- Keep historical links after runner issue deletion; issue_id is an audit reference,
-- not an ownership foreign key.
create unique index if not exists idx_external_links_unique
  on external_links(source, external_id, external_type, external_event_id,
    project_id, issue_id, conversation_id, loop_run_id, relationship);

create index if not exists idx_external_links_issue
  on external_links(issue_id, created_at desc, id desc);

create index if not exists idx_external_links_external
  on external_links(source, external_id, external_type, created_at desc, id desc);

create index if not exists idx_external_links_project
  on external_links(project_id, created_at desc, id desc);
`
};
