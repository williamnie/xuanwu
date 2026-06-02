import type { RunnerDatabase } from "../database.ts";

export type CronTask = {
  action: string;
  action_payload_json: string;
  created_at: string;
  error: string;
  id: number;
  last_error: string;
  last_result: string;
  last_run_at: string;
  last_status: string;
  mode: string;
  name: string;
  next_run_at: string;
  project_id: string;
  quiet_hours_json: string;
  run_count: number;
  schedule_expr: string;
  status: string;
  time_of_day: string;
  timezone: string;
  missed_run_policy: string;
  updated_at: string;
  working_hours_json: string;
};

type CronTaskRow = Omit<CronTask, "last_error">;

const CRON_TASK_COLUMNS = `c.id, c.name, c.project_id, c.action, c.mode, c.time_of_day,
  c.next_run_at, c.last_run_at, c.last_status, c.last_result, c.status, c.run_count,
  c.error, c.created_at, c.updated_at,
  coalesce(s.schedule_expr, '') as schedule_expr,
  coalesce(s.timezone, 'UTC') as timezone,
  coalesce(s.missed_run_policy, 'run_immediately') as missed_run_policy,
  coalesce(s.quiet_hours_json, '{}') as quiet_hours_json,
  coalesce(s.working_hours_json, '{}') as working_hours_json,
  coalesce(s.action_payload_json, '{}') as action_payload_json`;

export function listCronTasks(db: RunnerDatabase): CronTask[] {
  return db.sqlite.query<CronTaskRow, []>(`
    select ${CRON_TASK_COLUMNS} from cron_tasks c
    left join cron_task_schedules s on s.cron_task_id=c.id
    order by c.created_at desc
  `).all().map(mapCronTaskRow);
}

function mapCronTaskRow(row: CronTaskRow): CronTask {
  const error = optionalString(row.error);
  return {
    id: positiveInteger(row.id, "cron_tasks.id"),
    name: requiredString(row.name, "cron_tasks.name"),
    project_id: optionalString(row.project_id),
    action: requiredString(row.action, "cron_tasks.action"),
    mode: requiredString(row.mode, "cron_tasks.mode"),
    time_of_day: optionalString(row.time_of_day),
    next_run_at: optionalString(row.next_run_at),
    last_run_at: optionalString(row.last_run_at),
    last_status: optionalString(row.last_status),
    last_result: optionalString(row.last_result),
    status: requiredString(row.status, "cron_tasks.status"),
    run_count: integerValue(row.run_count, "cron_tasks.run_count"),
    error,
    last_error: error,
    created_at: requiredString(row.created_at, "cron_tasks.created_at"),
    updated_at: requiredString(row.updated_at, "cron_tasks.updated_at"),
    schedule_expr: optionalString(row.schedule_expr),
    timezone: optionalString(row.timezone) || "UTC",
    missed_run_policy: optionalString(row.missed_run_policy) || "run_immediately",
    quiet_hours_json: optionalString(row.quiet_hours_json) || "{}",
    working_hours_json: optionalString(row.working_hours_json) || "{}",
    action_payload_json: optionalString(row.action_payload_json) || "{}"
  };
}

function optionalString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new Error("expected string row value");
  return value.trim();
}

function requiredString(value: unknown, label: string): string {
  const text = optionalString(value);
  if (text === "") throw new Error(`${label} is required`);
  return text;
}

function positiveInteger(value: unknown, label: string): number {
  const number = integerValue(value, label);
  if (number <= 0) throw new Error(`${label} must be positive`);
  return number;
}

function integerValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return value;
}
