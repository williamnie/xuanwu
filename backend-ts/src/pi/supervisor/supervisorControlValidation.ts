import type { RunnerDatabase } from "../../db/database.ts";
import { getPiActionByIdempotencyKey } from "../../db/repositories/pi.ts";
import type { Project } from "../../db/repositories/projects.ts";
import { workIDToIssueID } from "../../domain/work/issueAdapter.ts";
import type { PiRunnerActionContext } from "../runnerTools/runnerActions.ts";
import { cleanString, isRecord, objectValue } from "../../util/values.ts";

export function domainAudit(context: PiRunnerActionContext, eventID: string, reason: string) {
  return {
    actor: {
      id: cleanString(context.conversationID) || cleanString(context.delegationID) || "xuanwu-supervisor",
      kind: "supervisor"
    },
    correlation_id: cleanString(context.conversationID) || cleanString(context.heartbeatID) || eventID,
    event_id: eventID,
    occurred_at: new Date().toISOString(),
    reason
  };
}

export function scopedIdempotencyKey(actionType: string, projectIDValue: string, target: string, value: string): string {
  return ["supervisor-control", actionType, projectIDValue || "global", target, requiredString(value, "idempotency_key")].join(":");
}

export function assertIdempotencyCompatible(
  db: RunnerDatabase,
  key: string,
  actionType: string,
  projectIDValue: string,
  issueID: number,
  payload: Record<string, unknown>
): void {
  const existing = getPiActionByIdempotencyKey(db, key);
  if (!existing) return;
  const matches = existing.action_type === actionType && existing.project_id === projectIDValue &&
    existing.issue_id === issueID && stableJson(jsonValue(existing.payload_json)) === stableJson(payload);
  if (!matches) throw new Error("idempotency_key conflicts with another Supervisor control command");
}

export function targetProjectID(db: RunnerDatabase, workIDValue: string, fallback?: Project): string {
  const issueID = workIDToIssueID(workIDValue);
  const row = db.sqlite.query<{ project_id: string }, [number]>("select project_id from issues where id=?").get(issueID);
  return row?.project_id ?? fallback?.id ?? "";
}

export function runProjectID(db: RunnerDatabase, runIDValue: string, fallback?: Project): string {
  const run = requireRunTarget(db, runIDValue);
  return cleanString(run.project_id) || fallback?.id || "";
}

export function requireRunTarget(db: RunnerDatabase, runIDValue: string): Record<string, unknown> {
  const row = db.sqlite.query<Record<string, unknown>, [string]>(`
    select issue.project_id, run.work_id from issue_runs run
    join issues issue on issue.id=run.issue_id where run.run_id=?
  `).get(runIDValue);
  if (!row) throw new Error("Run not found");
  return row;
}

export function projectID(value: unknown, fallback?: Project): string {
  return cleanString(value) || fallback?.id || "";
}

export function requiredProjectID(value: unknown, fallback?: Project): string {
  const id = projectID(value, fallback);
  if (id === "") throw new Error("project_id is required");
  return id;
}

export function queryPath(path: string, input: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(input)) {
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      if (value === undefined || value === null) continue;
      if (typeof value === "string" && value.trim() === "") continue;
      params.append(key, String(value));
    }
  }
  const query = params.toString();
  return query === "" ? path : `${path}?${query}`;
}

export function limit(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? Math.min(value, 20) : 10;
}

export function boundedText(value: unknown, max: number): string {
  const text = cleanString(value);
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function select(value: unknown, keys: string[]): Record<string, unknown> {
  const record = objectValue(value);
  return cleanObject(Object.fromEntries(keys.map((key) => [key, record[key]])));
}

export function cleanObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ""));
}

export function requiredString(value: unknown, label: string): string {
  const text = cleanString(value);
  if (text === "") throw new Error(`${label} is required`);
  return text;
}

export function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
