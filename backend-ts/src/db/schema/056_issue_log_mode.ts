import type { SqlMigration } from "../migrations.ts";

export const issueLogModeMigration: SqlMigration = {
  id: "056_issue_log_mode",
  sql: `
alter table issues add column issue_log_mode text not null default 'normal'
  check(issue_log_mode in ('normal', 'debug'));

create index if not exists idx_issue_events_issue_id_desc
  on issue_events(issue_id, id desc);
`
};
