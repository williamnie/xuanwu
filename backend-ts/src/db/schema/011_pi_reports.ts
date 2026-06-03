import type { SqlMigration } from "../migrations.ts";

export const piReportsMigration: SqlMigration = {
  id: "011_pi_reports",
  sql: `
create table if not exists pi_reports (
  id integer primary key autoincrement,
  project_id text not null default '',
  type text not null,
  summary_json text not null default '{}',
  body_json text not null default '{}',
  generated_at text not null,
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_pi_reports_scope
  on pi_reports(project_id, generated_at desc, id desc);
`
};
