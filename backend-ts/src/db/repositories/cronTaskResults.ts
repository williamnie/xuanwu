import type { RunnerDatabase } from "../database.ts";
import { nextRunAfter } from "../../schedule/cronSchedule.ts";
import type { CronTask } from "./cronTasks.ts";

const TERMINAL_ONCE_STATUS = "done";

export function recordCronTaskSuccess(db: RunnerDatabase, input: CronResultInput): void {
  recordCronTaskRun(db, input, {
    error: "",
    lastResult: input.result,
    lastStatus: "success",
    nextRunAt: nextRunAt(input.task, input.now),
    status: nextStatus(input.task)
  });
}

export function recordCronTaskError(db: RunnerDatabase, input: CronResultInput): void {
  recordCronTaskRun(db, input, {
    error: input.result,
    lastResult: input.result,
    lastStatus: "error",
    nextRunAt: nextRunAt(input.task, input.now),
    status: nextStatus(input.task)
  });
}

export function recordCronTaskSkip(db: RunnerDatabase, input: CronResultInput & { nextRunAt: string }): void {
  recordCronTaskRun(db, input, {
    error: "",
    lastResult: input.result,
    lastStatus: "skipped",
    nextRunAt: input.nextRunAt,
    status: "active"
  });
}

type CronResultInput = { now: Date; result: string; task: CronTask };

function recordCronTaskRun(db: RunnerDatabase, input: CronResultInput, patch: {
  error: string; lastResult: string; lastStatus: string; nextRunAt: string; status: string;
}): void {
  const timestamp = input.now.toISOString();
  db.sqlite.run(`update cron_tasks set last_run_at=?, last_status=?, last_result=?,
    run_count=run_count+1, error=?, next_run_at=?, status=?, claim_token='',
    claim_started_at='', updated_at=? where id=?`,
    [timestamp, patch.lastStatus, patch.lastResult, patch.error, patch.nextRunAt,
      patch.status, timestamp, input.task.id]);
}

function nextRunAt(task: CronTask, now: Date): string {
  if (task.mode === "once") return "";
  return nextRunAfter(task, now);
}

function nextStatus(task: CronTask): string {
  return task.mode === "once" ? TERMINAL_ONCE_STATUS : "active";
}
