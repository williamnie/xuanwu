import type { RunnerDatabase } from "../db/database.ts";
import type { CronTask } from "../db/repositories/cronTasks.ts";

export type ScheduleIssueRef = { id: number; project_id: string };

export function selectScheduleEnqueueIssues(
  db: RunnerDatabase,
  task: CronTask
): ScheduleIssueRef[] {
  const ids = payloadIssueIDs(task);
  return ids.length > 0 ? selectIssuesByID(db, ids) : selectProjectTriageIssues(db, task);
}

function selectProjectTriageIssues(
  db: RunnerDatabase,
  task: CronTask
): ScheduleIssueRef[] {
  return db.sqlite.query<ScheduleIssueRef, string[]>(`
    select id, project_id from issues
    where status='triage' ${task.project_id === "" ? "" : "and project_id=?"}
    order by priority desc, created_at asc, id asc
  `).all(...(task.project_id === "" ? [] : [task.project_id]));
}

function selectIssuesByID(db: RunnerDatabase, ids: number[]): ScheduleIssueRef[] {
  const placeholders = ids.map(() => "?").join(",");
  return db.sqlite.query<ScheduleIssueRef, number[]>(`
    select id, project_id from issues where id in (${placeholders}) order by id asc
  `).all(...ids);
}

function payloadIssueIDs(task: CronTask): number[] {
  return uniqueNumbers(numberList(parsePayload(task).issue_ids));
}

function parsePayload(task: CronTask): Record<string, unknown> {
  try {
    const parsed = JSON.parse(task.action_payload_json || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function numberList(value: unknown): number[] {
  if (Array.isArray(value)) return value.flatMap(numberList);
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return [value];
  const text = cleanString(value);
  if (text === "") return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed.flatMap(numberList);
  } catch {}
  return text.split(",").map((item) => Number.parseInt(item.trim(), 10)).filter((item) => Number.isSafeInteger(item) && item > 0);
}

function uniqueNumbers(values: number[]): number[] {
  return Array.from(new Set(values));
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
