import type { SqlMigration } from "../migrations.ts";

export const githubIssueCasesMigration: SqlMigration = {
  id: "086_github_issue_cases",
  sql: `
create table if not exists github_issue_cases (
  issue_node_id text primary key,
  repository_id integer not null,
  repository text not null,
  issue_number integer not null,
  project_id text not null references projects(id) on delete restrict,
  source_revision integer not null default 1,
  source_fingerprint text not null,
  source_json text not null,
  external_updated_at text not null,
  external_state text not null,
  issue_id integer references issues(id) on delete restrict,
  work_source_revision integer not null default 0,
  stage text not null default 'intake',
  report_json text not null default '{}',
  pull_request_number integer,
  head_sha text not null default '',
  delivery_json text not null default '{}',
  review_cursor integer not null default 0,
  review_binding_json text not null default '{}',
  comment_cursor integer not null default 0,
  last_error text not null default '',
  created_at text not null,
  updated_at text not null,
  unique(repository_id, issue_number)
);
create index if not exists idx_github_issue_cases_project on github_issue_cases(project_id, updated_at);
create index if not exists idx_github_issue_cases_work on github_issue_cases(issue_id);
create unique index if not exists ux_sync_outbox_github_issue_dedupe
  on sync_outbox(source, operation_kind, dedupe_key)
  where operation_kind='github_issue' and dedupe_key<>'';
`
};
