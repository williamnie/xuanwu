import { Value } from "@sinclair/typebox/value";
import type { RunnerDatabase } from "../database.ts";
import { HANDOFF_SCHEMA, type HandoffRecord } from "../../domain/handoff/contracts.ts";
import {
  type HandoffListFilter,
  type HandoffEventRow,
  type StoredHandoffRecord,
  type HandoffRecordEventType
} from "./handoffs.ts";

export const HANDOFF_RECORD_EVENT_TYPES = [
  "handoff.prepared.v1",
  "handoff.delivery_requested.v1",
  "handoff.delivery_completed.v1",
  "handoff.delivery_failed.v1",
  "handoff.superseded.v1"
] as const;

export function handoffListQuery(filter: HandoffListFilter): {
  args: Array<number | string>;
  row_limit: number;
  sql: string;
} {
  const query = handoffListWhere(filter);
  const args = [...query.args];
  const rowLimit = Math.min(filter.limit * 4 + 1, 401);
  args.push(rowLimit);
  return {
    args,
    row_limit: rowLimit,
    sql: `select event.id as event_id, event.type as event_type, event.issue_id, event.payload, issue.project_id
      from issue_events event
      join issues issue on issue.id=event.issue_id
      where ${query.clauses.join(" and ")}
      order by event.id desc limit ?`
  };
}

export function handoffListWhere(
  filter: Omit<HandoffListFilter, "limit">
): { args: Array<number | string>; clauses: string[] } {
  const placeholders = HANDOFF_RECORD_EVENT_TYPES.map(() => "?").join(", ");
  const clauses = [
    `event.type in (${placeholders})`,
    "json_valid(event.payload)",
    `not exists (
      select 1 from issue_events newer
      where newer.issue_id=event.issue_id and newer.type in (${placeholders}) and json_valid(newer.payload)
        and json_extract(newer.payload, '$.handoff.id')=json_extract(event.payload, '$.handoff.id')
        and (
          cast(json_extract(newer.payload, '$.handoff.revision') as integer) >
            cast(json_extract(event.payload, '$.handoff.revision') as integer)
          or (
            cast(json_extract(newer.payload, '$.handoff.revision') as integer)=
              cast(json_extract(event.payload, '$.handoff.revision') as integer)
            and newer.id > event.id
          )
        )
    )`
  ];
  const args: Array<number | string> = [...HANDOFF_RECORD_EVENT_TYPES, ...HANDOFF_RECORD_EVENT_TYPES];
  addFilter(clauses, args, "event.id < ?", filter.before_event_id);
  addFilter(clauses, args, "issue.project_id=?", filter.project_id);
  // Issue-backed Work 查询先走 issue_id 索引，避免逐任务统计反复扫描全部交付事件。
  const issueID = /^xw:work:issues:([1-9]\d*)$/.exec(filter.work_id || "")?.[1];
  if (issueID) addFilter(clauses, args, "event.issue_id=?", Number(issueID));
  addFilter(clauses, args, "json_extract(event.payload, '$.handoff.work_id')=?", filter.work_id);
  addListFilter(clauses, args, "json_extract(event.payload, '$.handoff.status')", filter.statuses);
  addListFilter(clauses, args, "json_extract(event.payload, '$.handoff.delivery.mode')", filter.delivery_modes);
  return { args, clauses };
}

export function storedHandoff(row: HandoffEventRow): StoredHandoffRecord | null {
  try {
    if (!HANDOFF_RECORD_EVENT_TYPES.includes(row.event_type as HandoffRecordEventType)) return null;
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    if (!Value.Check(HANDOFF_SCHEMA, payload.handoff)) return null;
    const recordedAt = canonicalTimestamp(payload.recorded_at, "Handoff recorded_at");
    const source = requiredText(payload.source, "Handoff source");
    return {
      event_id: positiveInteger(row.event_id, "Handoff event id"),
      event_type: row.event_type as HandoffRecordEventType,
      handoff: payload.handoff as HandoffRecord,
      issue_id: positiveInteger(row.issue_id, "Handoff issue id"),
      project_id: requiredText(row.project_id, "Handoff project id"),
      recorded_at: recordedAt,
      source
    };
  } catch {
    return null;
  }
}

export function projectIDForIssue(db: RunnerDatabase, issueID: number): string {
  const row = db.sqlite.query<{ project_id: string }, [number]>(
    "select project_id from issues where id=?"
  ).get(issueID);
  if (!row) throw new Error("Handoff Issue not found");
  return requiredText(row.project_id, "Handoff project id");
}

export function assertIssueBackedWork(issueID: number, workID: string): void {
  const match = /^xw:work:issues:([1-9][0-9]*)$/.exec(workID);
  if (!match || Number(match[1]) !== issueID) throw new Error("Handoff belongs to another Issue-backed Work");
}

function addFilter(
  clauses: string[],
  args: Array<number | string>,
  expression: string,
  value: number | string | undefined
): void {
  if (value === undefined || value === "") return;
  clauses.push(expression);
  args.push(value);
}

function addListFilter(
  clauses: string[],
  args: Array<number | string>,
  expression: string,
  values: readonly string[] | undefined
): void {
  const normalized = [...new Set(values ?? [])];
  if (normalized.length === 0) return;
  clauses.push(`${expression} in (${normalized.map(() => "?").join(", ")})`);
  args.push(...normalized);
}

export function canonicalTimestamp(value: unknown, label: string): string {
  const text = requiredText(value, label);
  const timestamp = new Date(text);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== text) throw new Error(`${label} must be canonical ISO`);
  return text;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

export function requiredText(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") throw new Error(`${label} is required`);
  return text;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
