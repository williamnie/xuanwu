import { claimDueCronTasks } from "../db/repositories/cronTaskClaims.ts";
import type { RunnerConfig } from "../config/env.ts";
import { recordCronTaskError, recordCronTaskSkip, recordCronTaskSuccess } from "../db/repositories/cronTaskResults.ts";
import type { CronTask } from "../db/repositories/cronTasks.ts";
import type { EventBus } from "../events/bus.ts";
import { runDelegationHeartbeatsOnce } from "../pi/heartbeatOrchestrator.ts";
import type { PiAutoManageProjectCycle } from "./piAutoManageScheduler.ts";
import { cronTaskWithProjectPolicy } from "../schedule/cronTaskPolicy.ts";
import { startProjectLoop as defaultStartProjectLoop, type ProjectLoopRuntime } from "./projectLoopManager.ts";
import { nextRunAfter, quietHoursResumeAt } from "../schedule/cronSchedule.ts";
import { dispatchScheduleAction, type ScheduleActionResult } from "./scheduleActionDispatcher.ts";

export type CronExecutorResult = { executed: number; failed: number; scanned: number; skipped: number };

export type CronExecutorInput = ProjectLoopRuntime & {
  bus?: EventBus;
  codexSessionsDir?: string;
  config?: RunnerConfig;
  now?: Date;
  runProjectCycle?: PiAutoManageProjectCycle;
  startProjectLoop?: (runtime: ProjectLoopRuntime, projectID: string) => void;
};

type CronActionResult = ScheduleActionResult;

const activeCronTasks = new Set<number>();

export async function runDueCronTasks(input: CronExecutorInput): Promise<CronExecutorResult> {
  const now = input.now ?? new Date();
  const tasks = claimDueCronTasks(input.database, now);
  const result: CronExecutorResult = { executed: 0, failed: 0, scanned: tasks.length, skipped: 0 };
  for (const task of tasks) {
    const status = await runCronTask(input, task, now);
    result[status] += 1;
  }
  return result;
}

async function runCronTask(input: CronExecutorInput, task: CronTask, now: Date): Promise<"executed" | "failed" | "skipped"> {
  activeCronTasks.add(task.id);
  try {
    const effectiveTask = cronTaskWithProjectPolicy(input.database, task);
    const quietResumeAt = quietHoursResumeAt(effectiveTask, now);
    if (quietResumeAt !== "") {
      recordCronTaskSkip(input.database, { nextRunAt: quietResumeAt, now, result: `quiet hours until ${quietResumeAt}`, task: effectiveTask });
      return "skipped";
    }
    if (shouldSkipMissedRun(effectiveTask, now)) {
      recordCronTaskSkip(input.database, { nextRunAt: nextRun(effectiveTask, now), now, result: "missed run skipped by policy", task: effectiveTask });
      return "skipped";
    }
    try {
      const actionResult = await executeCronAction(input, effectiveTask, now);
      if (actionResult.skipped === true) {
        recordCronTaskSkip(input.database, { nextRunAt: nextRun(effectiveTask, now), now, result: actionResult.detail, task: effectiveTask });
        return "skipped";
      }
      recordCronTaskSuccess(input.database, { now, result: actionResult.detail, task: effectiveTask });
      kickProjects(input, actionResult.projectIDs ?? []);
      return "executed";
    } catch (error) {
      recordCronTaskError(input.database, { now, result: safeError(error), task: effectiveTask });
      return "failed";
    }
  } finally {
    activeCronTasks.delete(task.id);
  }
}

function shouldSkipMissedRun(task: CronTask, now: Date): boolean {
  if (task.missed_run_policy !== "skip" || task.mode === "once") return false;
  const due = Date.parse(task.next_run_at);
  return Number.isFinite(due) && now.getTime() - due > 60_000;
}

async function executeCronAction(input: CronExecutorInput, task: CronTask, now: Date): Promise<CronActionResult> {
  return await dispatchScheduleAction({
    bus: input.bus,
    codexSessionsDir: input.codexSessionsDir,
    config: input.config,
    database: input.database,
    now,
    runProjectCycle: input.runProjectCycle
  }, task);
}

function nextRun(task: CronTask, now: Date): string {
  if (task.mode === "once") return "";
  return nextRunAfter(task, now);
}

function kickProjects(input: CronExecutorInput, projectIDs: string[]): void {
  const starter = input.startProjectLoop ?? defaultStartProjectLoop;
  for (const projectID of projectIDs) starter(input, projectID);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
