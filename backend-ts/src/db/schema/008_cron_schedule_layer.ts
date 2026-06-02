import type { SqlMigration } from "../migrations.ts";

export const cronScheduleLayerMigration: SqlMigration = {
  id: "008_cron_schedule_layer",
  sql: `
create table if not exists cron_task_schedules (
  cron_task_id integer primary key,
  schedule_expr text not null default '',
  timezone text not null default 'UTC',
  missed_run_policy text not null default 'run_immediately',
  quiet_hours_json text not null default '{}',
  working_hours_json text not null default '{}',
  action_payload_json text not null default '{}',
  created_at text not null,
  updated_at text not null,
  foreign key(cron_task_id) references cron_tasks(id) on delete cascade
);

create index if not exists idx_cron_task_schedules_timezone
  on cron_task_schedules(timezone);
`
};
