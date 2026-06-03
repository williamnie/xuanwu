import type { RunnerDatabase } from "../database.ts";
import { parseScheduleExpression } from "../../schedule/cronSchedule.ts";
import { issueTimestamp } from "./issueCreate.ts";
import { ProjectNotFoundError } from "./projects.ts";
import { listCronTasks, type CronTask } from "./cronTasks.ts";

type CronInput = Partial<Record<keyof CronTask, unknown>>;
const DEFAULT_ACTION = "triage_to_todo";
const ACTIONS = new Set(["triage_to_todo", "start_delegation", "run_heartbeat", "run_pi_cycle", "enqueue_issues", "generate_report", "check_stale_sessions", "sync_projects"]);
const STATUSES = new Set(["active", "paused", "done"]);
const MODES = new Set(["once", "daily", "weekly", "monthly"]);
const MISSED_POLICIES = new Set(["skip", "run_immediately", "catch_up_once"]);

export function getCronTask(db: RunnerDatabase, id: number): CronTask | null {
  return listCronTasks(db).find((task) => task.id === id) ?? null;
}

export function createCronTask(db: RunnerDatabase, input: CronInput): CronTask {
  const task = normalizeCronTask(input, new Date());
  const timestamp = issueTimestamp();
  const write = db.transaction((record: CronTask) => {
    db.sqlite.run(`insert into cron_tasks
      (name, project_id, action, mode, time_of_day, next_run_at, status, error, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.name, record.project_id, record.action, record.mode, record.time_of_day, record.next_run_at,
        record.status, record.error, timestamp, timestamp]);
    const id = lastInsertID(db);
    upsertScheduleMeta(db, id, record, timestamp);
    return id;
  });
  return mustGetCronTask(db, write(task));
}

export function updateCronTask(db: RunnerDatabase, id: number, input: CronInput): CronTask {
  const current = getCronTask(db, id);
  if (!current) throw new ProjectNotFoundError();
  const next = normalizeCronTask({ ...current, ...patchValues(input) }, new Date());
  const timestamp = issueTimestamp();
  const write = db.transaction((record: CronTask) => {
    db.sqlite.run(`update cron_tasks set name=?, project_id=?, action=?, mode=?, time_of_day=?,
      next_run_at=?, status=?, error=?, updated_at=? where id=?`,
      [record.name, record.project_id, record.action, record.mode, record.time_of_day,
        record.next_run_at, record.status, record.error, timestamp, id]);
    upsertScheduleMeta(db, id, record, timestamp);
  });
  write(next);
  return mustGetCronTask(db, id);
}

export function deleteCronTask(db: RunnerDatabase, id: number): void {
  const result = db.sqlite.run("delete from cron_tasks where id=?", [id]);
  if (result.changes === 0) throw new ProjectNotFoundError();
}

function normalizeCronTask(input: CronInput, base: Date): CronTask {
  const parsed = parsedSchedule(input, base);
  const mode = cleanString(input.mode) || parsed.mode || "once";
  const status = cleanString(input.status) || "active";
  const task = {
    id: integerInput(input.id), name: cleanString(input.name), project_id: cleanString(input.project_id),
    action: cleanString(input.action) || DEFAULT_ACTION, mode, time_of_day: cleanString(input.time_of_day) || parsed.time_of_day,
    next_run_at: cleanString(input.next_run_at) || parsed.next_run_at, last_run_at: cleanString(input.last_run_at),
    last_status: cleanString(input.last_status), last_result: cleanString(input.last_result), status,
    run_count: integerInput(input.run_count), error: cleanString(input.error), last_error: cleanString(input.error),
    created_at: "", updated_at: "", schedule_expr: cleanString(input.schedule_expr),
    timezone: cleanString(input.timezone) || parsed.timezone || "UTC",
    missed_run_policy: cleanString(input.missed_run_policy) || "run_immediately",
    quiet_hours_json: jsonText(input.quiet_hours_json),
    working_hours_json: jsonText(input.working_hours_json, parsed.working_hours_json),
    action_payload_json: jsonText(input.action_payload_json)
  };
  validateCronTask(task);
  normalizeCronRunTime(task, base);
  task.name ||= task.mode === "daily" ? `每日运行 Triage - ${task.project_id || "所有项目"}` : `定时运行 Triage - ${task.project_id || "所有项目"}`;
  return task;
}

function validateCronTask(task: CronTask): void {
  if (!ACTIONS.has(task.action)) throw new Error(`cron task 不合法: unsupported action ${task.action}`);
  if (!MODES.has(task.mode)) throw new Error(`cron task 不合法: unsupported mode ${task.mode}`);
  if (!STATUSES.has(task.status)) throw new Error(`cron task 不合法: unsupported status ${task.status}`);
  if (!MISSED_POLICIES.has(task.missed_run_policy)) throw new Error(`cron task 不合法: unsupported missed_run_policy ${task.missed_run_policy}`);
  validateTimezone(task.timezone);
  validateJson(task.quiet_hours_json, "quiet_hours_json");
  validateJson(task.working_hours_json, "working_hours_json");
  validateJson(task.action_payload_json, "action_payload_json");
}

function normalizeCronRunTime(task: CronTask, base: Date): void {
  if (task.mode === "daily") {
    if (task.time_of_day === "" && task.next_run_at !== "") task.time_of_day = timeOfDay(task.next_run_at);
    validateTimeOfDay(task.time_of_day);
    if (task.next_run_at === "" && task.status === "active") task.next_run_at = nextDailyRun(task.time_of_day, base).toISOString();
    return;
  }
  if ((task.mode === "weekly" || task.mode === "monthly") && task.time_of_day !== "") validateTimeOfDay(task.time_of_day);
  if (task.next_run_at === "" && task.status === "active") throw new Error("cron task 不合法: once 任务需要 next_run_at");
  if (task.next_run_at !== "") task.next_run_at = parseFuture(task.next_run_at, base, task.status).toISOString();
}

function parseFuture(value: string, base: Date, status: string): Date {
  const next = new Date(value);
  if (Number.isNaN(next.getTime())) throw new Error("cron task 不合法: next_run_at 需要 RFC3339");
  if (status === "active" && next.getTime() <= base.getTime()) throw new Error("cron task 不合法: next_run_at 必须晚于当前时间");
  return next;
}

function nextDailyRun(time: string, base: Date): Date {
  const [hour, minute] = time.split(":").map(Number);
  const next = new Date(base);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= base.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

function timeOfDay(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function validateTimeOfDay(value: string): void {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error("cron task 不合法: time_of_day 需要 HH:MM");
}

function mustGetCronTask(db: RunnerDatabase, id: number): CronTask {
  const task = getCronTask(db, id);
  if (!task) throw new Error("cron task missing after write");
  return task;
}

function parsedSchedule(input: CronInput, base: Date) {
  const scheduleExpr = cleanString(input.schedule_expr);
  if (scheduleExpr === "") return { mode: "", next_run_at: "", time_of_day: "", timezone: "", working_hours_json: "{}" };
  return parseScheduleExpression(scheduleExpr, { base, timezone: cleanString(input.timezone) || "UTC" });
}

function upsertScheduleMeta(db: RunnerDatabase, id: number, task: CronTask, timestamp: string): void {
  db.sqlite.run(`insert into cron_task_schedules
    (cron_task_id, schedule_expr, timezone, missed_run_policy, quiet_hours_json,
      working_hours_json, action_payload_json, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(cron_task_id) do update set schedule_expr=excluded.schedule_expr,
      timezone=excluded.timezone, missed_run_policy=excluded.missed_run_policy,
      quiet_hours_json=excluded.quiet_hours_json, working_hours_json=excluded.working_hours_json,
      action_payload_json=excluded.action_payload_json, updated_at=excluded.updated_at`,
    [id, task.schedule_expr, task.timezone, task.missed_run_policy, task.quiet_hours_json,
      task.working_hours_json, task.action_payload_json, timestamp, timestamp]);
}

function lastInsertID(db: RunnerDatabase): number { return db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0; }
function patchValues(input: CronInput): CronInput { return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null && value !== undefined)); }
function cleanString(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function integerInput(value: unknown): number { return typeof value === "number" && Number.isInteger(value) ? value : 0; }
function jsonText(value: unknown, fallback = "{}"): string { return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback; }

function validateJson(value: string, label: string): void {
  try {
    JSON.parse(value);
  } catch {
    throw new Error(`cron task 不合法: ${label} 需要 JSON`);
  }
}

function validateTimezone(value: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
  } catch {
    throw new Error(`cron task 不合法: timezone unsupported ${value}`);
  }
}
