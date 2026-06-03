import { readProjectPiPolicy } from "../db/repositories/pi.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { CronTask } from "../db/repositories/cronTasks.ts";

export function cronTaskWithProjectPolicy(db: RunnerDatabase, task: CronTask): CronTask {
  if (task.project_id === "") return task;
  const policy = readProjectPiPolicy(db, task.project_id);
  const inheritsProjectPolicy = isEmptyObjectText(task.quiet_hours_json) || isEmptyObjectText(task.working_hours_json);
  return {
    ...task,
    quiet_hours_json: policyText(task.quiet_hours_json, policy.quiet_hours_json),
    timezone: inheritedTimezone(task.timezone, policy.timezone, inheritsProjectPolicy),
    working_hours_json: policyText(task.working_hours_json, policy.working_hours_json)
  };
}

function policyText(taskValue: string, projectValue: string): string {
  return isEmptyObjectText(taskValue) ? projectValue : taskValue;
}

function isEmptyObjectText(value: string): boolean {
  if (value.trim() === "" || value.trim() === "{}") return true;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length === 0;
  } catch {
    return false;
  }
}

function inheritedTimezone(taskValue: string, policyValue: string, inherited: boolean): string {
  if (!inherited) return taskValue || policyValue;
  return taskValue === "" || taskValue === "UTC" ? policyValue : taskValue;
}
