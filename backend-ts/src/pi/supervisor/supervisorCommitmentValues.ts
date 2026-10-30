import type { RunnerDatabase } from "../../db/database.ts";
import { getIssueAsWork } from "../../domain/work/issueAdapter.ts";
import { cleanString } from "../../util/values.ts";
import { MAX_LIMIT, DEFAULT_LIMIT } from "./supervisorCommitmentModel.ts";

export function assertUnfinishedAuthoritativeWork(db: RunnerDatabase, value: unknown): void {
  const issueIDs = uniquePositiveIntegers(value);
  if (issueIDs.length === 0) throw new Error("issue_ids is required for a Supervisor commitment");
  for (const issueID of issueIDs) {
    const work = getIssueAsWork(db, issueID);
    if (!work) throw new Error(`authoritative Work xw:work:issues:${issueID} not found`);
    if (["done", "failed", "cancelled"].includes(work.status)) {
      throw new Error(`authoritative Work ${work.id} is already ${work.status}`);
    }
  }
}

export function uniquePositiveIntegers(value: unknown): number[] {
  const items = Array.isArray(value) ? value : [value];
  return [...new Set(items.filter((item): item is number => (
    typeof item === "number" && Number.isSafeInteger(item) && item > 0
  )))];
}

export function objectValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function optionalTimestamp(value: unknown, field: string): string {
  const text = cleanString(value);
  if (text === "") return "";
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${field} must be an RFC3339 timestamp`);
  return new Date(text).toISOString();
}

export function requiredText(value: unknown, field: string): string {
  const text = cleanString(value);
  if (text === "") throw new Error(`${field} is required for a Supervisor commitment`);
  return text;
}

export function boundedLimit(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, MAX_LIMIT)
    : DEFAULT_LIMIT;
}
