import type { RunnerDatabase } from "../../db/database.ts";
import { type Issue } from "../../db/repositories/issues.ts";
import type { PiAction } from "../../db/repositories/pi.ts";
import { cleanString, objectValue, positiveInteger } from "../../util/values.ts";

export function issueSnapshot(issue: Issue): Record<string, unknown> {
  return {
    issue_id: issue.id,
    project_id: issue.project_id,
    status: issue.status,
    updated_at: issue.updated_at
  };
}

export function newerCompletedEnqueue(db: RunnerDatabase, action: PiAction): string {
  if (action.issue_id <= 0) return "";
  return db.sqlite.query<{ id: string }, [number, string, string]>(`
    select id from pi_actions
    where action_type='issue.enqueue' and issue_id=? and status='completed'
      and created_at>=? and id<>?
    order by created_at desc, id desc limit 1
  `).get(action.issue_id, action.created_at, action.id)?.id ?? "";
}

export function issueIDFromPayload(value: string): number {
  return positiveInteger(parseObject(value).issue_id);
}

export function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function arrayObjects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(objectValue).filter((item) => Object.keys(item).length > 0) : [];
}

export function numberList(value: unknown): number[] {
  if (Array.isArray(value)) return value.flatMap(numberList);
  return [positiveInteger(value)].filter((id) => id > 0);
}

export function uniquePositiveIDs(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isSafeInteger(value) && value > 0))];
}

export function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function rawRefTurnID(value: string): string {
  return cleanString(parseObject(value).provider_turn_id);
}

export function sessionIDFromKey(value: string): string {
  const separator = value.indexOf(":");
  return separator < 0 ? value : value.slice(separator + 1).trim();
}

export function normalizeState(value: string): string {
  return value.toLowerCase().replace(/[_\s-]/g, "");
}

export function timestampAfter(left: string, right: string): boolean {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs > rightMs;
}
