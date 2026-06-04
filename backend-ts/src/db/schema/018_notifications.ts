import type { SqlMigration } from "../migrations.ts";

export const notificationsMigration: SqlMigration = {
  id: "018_notifications",
  sql: `
create table if not exists notifications (
  id integer primary key autoincrement,
  event text not null,
  project_id text not null,
  issue_id integer not null default 0,
  dedupe_key text not null,
  title text not null default '',
  message text not null default '',
  payload text not null default '{}',
  created_at text not null,
  read_at text not null default '',
  foreign key(project_id) references projects(id) on delete cascade
);

create index if not exists idx_notifications_project_created
  on notifications(project_id, created_at desc, id desc);

create index if not exists idx_notifications_dedupe_created
  on notifications(dedupe_key, created_at desc, id desc);

create index if not exists idx_notifications_unread
  on notifications(project_id, read_at, created_at desc);
`
};
