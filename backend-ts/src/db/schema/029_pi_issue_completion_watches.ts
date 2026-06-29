import type { SqlMigration } from "../migrations.ts";

export const piIssueCompletionWatchesMigration: SqlMigration = {
  id: "029_pi_issue_completion_watches",
  sql: `
create table if not exists pi_issue_completion_watches (
  id text primary key,
  idempotency_key text not null,
  project_id text not null,
  origin_conversation_id text not null default '',
  source_event_id text not null default '',
  source_message_id text not null default '',
  target_channel text not null default '',
  target_chat_id text not null default '',
  target_thread_id text not null default '',
  target_message_id text not null default '',
  requested_by text not null default '',
  condition text not null default '{}',
  status text not null default 'active',
  created_at text not null,
  updated_at text not null,
  completed_at text not null default '',
  notified_at text not null default '',
  error text not null default '',
  foreign key(project_id) references projects(id) on delete cascade
);

create unique index if not exists ux_pi_issue_completion_watches_active_key
  on pi_issue_completion_watches(idempotency_key) where status='active';

create index if not exists idx_pi_issue_completion_watches_active
  on pi_issue_completion_watches(status, project_id, created_at desc);

create index if not exists idx_pi_issue_completion_watches_source
  on pi_issue_completion_watches(source_event_id, source_message_id, created_at desc);

create table if not exists pi_issue_completion_watch_items (
  watch_id text not null,
  issue_id integer not null,
  project_id text not null,
  initial_status text not null default '',
  last_status text not null default '',
  terminal_at text not null default '',
  created_at text not null,
  updated_at text not null,
  primary key (watch_id, issue_id),
  foreign key(watch_id) references pi_issue_completion_watches(id) on delete cascade,
  foreign key(issue_id) references issues(id) on delete cascade,
  foreign key(project_id) references projects(id) on delete cascade
);

create index if not exists idx_pi_issue_completion_watch_items_issue
  on pi_issue_completion_watch_items(issue_id, watch_id);

create index if not exists idx_pi_issue_completion_watch_items_project
  on pi_issue_completion_watch_items(project_id, last_status, updated_at desc);
`
};
