import type { RunnerDatabase } from "../database.ts";
import { issueTimestamp } from "./issueCreate.ts";
import { ProjectNotFoundError } from "./projects.ts";
import { listCronTasks, type CronTask } from "./cronTasks.ts";

type CronInput = Partial<Record<keyof CronTask, unknown>>;
const ACTION = "triage_to_todo";
const STATUSES = new Set(["active", "paused", "done"]);
const MODES = new Set(["once", "daily"]);

export function getCronTask(db: RunnerDatabase, id: number): CronTask | null {
  return listCronTasks(db).find((task) => task.id === id) ?? null;
}

export function createCronTask(db: RunnerDatabase, input: CronInput): CronTask {
  const task = normalizeCronTask(input, new Date());
  const timestamp = issueTimestamp();
  db.sqlite.run(`insert into cron_tasks
    (name, project_id, action, mode, time_of_day, next_run_at, status, error, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [task.name, task.project_id, task.action, task.mode, task.time_of_day, task.next_run_at,
      task.status, task.error, timestamp, timestamp]);
  return mustGetCronTask(db, lastInsertID(db));
}

export function updateCronTask(db: RunnerDatabase, id: number, input: CronInput): CronTask {
  const current = getCronTask(db, id);
  if (!current) throw new ProjectNotFoundError();
  const next = normalizeCronTask({ ...current, ...patchValues(input) }, new Date());
  db.sqlite.run(`update cron_tasks set name=?, project_id=?, action=?, mode=?, time_of_day=?,
    next_run_at=?, status=?, error=?, updated_at=? where id=?`,
    [next.name, next.project_id, next.action, next.mode, next.time_of_day,
      next.next_run_at, next.status, next.error, issueTimestamp(), id]);
  return mustGetCronTask(db, id);
}

export function deleteCronTask(db: RunnerDatabase, id: number): void {
  const result = db.sqlite.run("delete from cron_tasks where id=?", [id]);
  if (result.changes === 0) throw new ProjectNotFoundError();
}

function normalizeCronTask(input: CronInput, base: Date): CronTask {
  const mode = cleanString(input.mode) || "once";
  const status = cleanString(input.status) || "active";
  const task = {
    id: integerInput(input.id), name: cleanString(input.name), project_id: cleanString(input.project_id),
    action: cleanString(input.action) || ACTION, mode, time_of_day: cleanString(input.time_of_day),
    next_run_at: cleanString(input.next_run_at), last_run_at: cleanString(input.last_run_at),
    last_status: cleanString(input.last_status), last_result: cleanString(input.last_result), status,
    run_count: integerInput(input.run_count), error: cleanString(input.error), last_error: cleanString(input.error),
    created_at: "", updated_at: ""
  };
  validateCronTask(task);
  normalizeCronRunTime(task, base);
  task.name ||= task.mode === "daily" ? `每日运行 Triage - ${task.project_id || "所有项目"}` : `定时运行 Triage - ${task.project_id || "所有项目"}`;
  return task;
}

function validateCronTask(task: CronTask): void {
  if (task.action !== ACTION) throw new Error(`cron task 不合法: unsupported action ${task.action}`);
  if (!MODES.has(task.mode)) throw new Error(`cron task 不合法: unsupported mode ${task.mode}`);
  if (!STATUSES.has(task.status)) throw new Error(`cron task 不合法: unsupported status ${task.status}`);
}

function normalizeCronRunTime(task: CronTask, base: Date): void {
  if (task.mode === "daily") {
    if (task.time_of_day === "" && task.next_run_at !== "") task.time_of_day = timeOfDay(task.next_run_at);
    validateTimeOfDay(task.time_of_day);
    if (task.next_run_at === "" && task.status === "active") task.next_run_at = nextDailyRun(task.time_of_day, base).toISOString();
    return;
  }
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

function lastInsertID(db: RunnerDatabase): number { return db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0; }
function patchValues(input: CronInput): CronInput { return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null && value !== undefined)); }
function cleanString(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function integerInput(value: unknown): number { return typeof value === "number" && Number.isInteger(value) ? value : 0; }
