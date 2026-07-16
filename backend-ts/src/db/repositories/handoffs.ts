import { Value } from "@sinclair/typebox/value";
import type { RunnerDatabase } from "../database.ts";
import { getStoredEvidence } from "./evidence.ts";
import { recordIssueEvent } from "./issueEvents.ts";
import { getRun } from "./runs.ts";
import {
  HANDOFF_SCHEMA,
  evaluateHandoffTransition,
  validateHandoff,
  type HandoffLinkContext,
  type HandoffRecord,
  type HandoffTransitionCommand
} from "../../domain/handoff/contracts.ts";

export const HANDOFF_RECORD_EVENT_TYPES = [
  "handoff.prepared.v1",
  "handoff.delivery_requested.v1",
  "handoff.delivery_completed.v1",
  "handoff.delivery_failed.v1",
  "handoff.superseded.v1"
] as const;

export type HandoffRecordEventType = typeof HANDOFF_RECORD_EVENT_TYPES[number];

export type StoredHandoffRecord = {
  event_id: number;
  event_type: HandoffRecordEventType;
  handoff: HandoffRecord;
  issue_id: number;
  project_id: string;
  recorded_at: string;
  source: string;
};

export type HandoffListFilter = {
  before_event_id?: number;
  delivery_modes?: string[];
  limit: number;
  project_id?: string;
  statuses?: string[];
  work_id?: string;
};

export type HandoffListPage = {
  has_more: boolean;
  items: StoredHandoffRecord[];
  next_before_event_id?: number;
  skipped_invalid: number;
};

export type HandoffWriteContext = {
  recorded_at: string;
  source: string;
  transition?: HandoffTransitionCommand;
};

type HandoffEventRow = {
  event_id: number;
  event_type: string;
  issue_id: number;
  payload: string;
  project_id: string;
};

export function recordHandoff(
  db: RunnerDatabase,
  issueID: number,
  handoff: HandoffRecord,
  context: HandoffWriteContext
): { created: boolean; record: StoredHandoffRecord } {
  assertIssueBackedWork(issueID, handoff.work_id);
  const recordedAt = canonicalTimestamp(context.recorded_at, "Handoff recorded_at");
  const source = requiredText(context.source, "Handoff source");
  const links = linkContext(db, handoff);
  const validation = validateHandoff(handoff, links);
  if (!validation.ok) {
    throw new Error(`cannot persist invalid Handoff ${handoff.id}: ${validation.errors.join("; ")}`);
  }

  const existing = getStoredHandoff(db, handoff.id);
  if (existing) {
    if (stableJson(existing.handoff) === stableJson(handoff)) return { created: false, record: existing };
    assertRevisionUpdate(existing.handoff, handoff, context.transition, links);
  } else if (handoff.revision !== 0) {
    throw new Error(`initial Handoff ${handoff.id} revision must be 0`);
  }

  const event = recordIssueEvent(db, issueID, eventType(existing?.handoff, handoff), {
    handoff,
    recorded_at: recordedAt,
    source
  });
  const record = storedHandoff({
    event_id: event.id,
    event_type: event.type,
    issue_id: issueID,
    payload: event.payload,
    project_id: projectIDForIssue(db, issueID)
  });
  if (!record) throw new Error("Handoff record could not be read after persistence");
  return { created: true, record };
}

export function getStoredHandoff(db: RunnerDatabase, handoffID: string): StoredHandoffRecord | null {
  const placeholders = HANDOFF_RECORD_EVENT_TYPES.map(() => "?").join(", ");
  const rows = db.sqlite.query<HandoffEventRow, string[]>(`
    select event.id as event_id, event.type as event_type, event.issue_id, event.payload, issue.project_id
    from issue_events event
    join issues issue on issue.id=event.issue_id
    where event.type in (${placeholders})
      and json_valid(event.payload)
      and json_extract(event.payload, '$.handoff.id')=?
    order by cast(json_extract(event.payload, '$.handoff.revision') as integer) desc, event.id desc
    limit 20
  `).all(...HANDOFF_RECORD_EVENT_TYPES, handoffID);
  for (const row of rows) {
    const record = storedHandoff(row);
    if (record) return record;
  }
  return null;
}

export function listStoredHandoffs(db: RunnerDatabase, filter: HandoffListFilter): HandoffListPage {
  const query = handoffListQuery(filter);
  const rows = db.sqlite.query<HandoffEventRow, Array<number | string>>(query.sql).all(...query.args);
  const records: StoredHandoffRecord[] = [];
  let skippedInvalid = 0;
  for (const row of rows) {
    const record = storedHandoff(row);
    if (record) records.push(record);
    else skippedInvalid += 1;
  }
  const hasMore = records.length > filter.limit || rows.length === query.row_limit;
  const items = records.slice(0, filter.limit);
  const cursorEventID = records.length > filter.limit
    ? records[filter.limit - 1]?.event_id
    : hasMore ? rows.at(-1)?.event_id : undefined;
  return {
    has_more: hasMore,
    items,
    ...(cursorEventID ? { next_before_event_id: cursorEventID } : {}),
    skipped_invalid: skippedInvalid
  };
}

export function countStoredHandoffs(
  db: RunnerDatabase,
  filter: Omit<HandoffListFilter, "before_event_id" | "limit"> = {}
): number {
  const query = handoffListWhere(filter);
  return db.sqlite.query<{ count: number }, Array<number | string>>(`
    select count(*) as count
    from issue_events event
    join issues issue on issue.id=event.issue_id
    where ${query.clauses.join(" and ")}
  `).get(...query.args)?.count ?? 0;
}

function assertRevisionUpdate(
  current: HandoffRecord,
  next: HandoffRecord,
  transition: HandoffTransitionCommand | undefined,
  links: HandoffLinkContext
): void {
  if (next.revision !== current.revision + 1) throw new Error(`Handoff ${next.id} revision must increase by one`);
  if (next.work_id !== current.work_id || next.created_at !== current.created_at ||
    next.baseline_revision !== current.baseline_revision) {
    throw new Error(`Handoff ${next.id} immutable identity facts changed`);
  }
  if (next.updated_at < current.updated_at) throw new Error(`Handoff ${next.id} updated_at moved backwards`);
  if (next.status === current.status) return;
  if (!transition) throw new Error(`Handoff ${next.id} status change requires transition audit`);
  if (transition.to !== next.status) throw new Error(`Handoff ${next.id} transition target does not match the record`);
  const decision = evaluateHandoffTransition(current, links, transition);
  if (!decision.allowed) throw new Error(`Handoff ${next.id} transition rejected: ${decision.violations.join("; ")}`);
}

function eventType(current: HandoffRecord | undefined, next: HandoffRecord): HandoffRecordEventType {
  if (!current) return "handoff.prepared.v1";
  if (next.status === "delivered") return "handoff.delivery_completed.v1";
  if (next.status === "superseded") return "handoff.superseded.v1";
  if (next.delivery_actions.some((action) => action.outcome === "failed")) return "handoff.delivery_failed.v1";
  return "handoff.delivery_requested.v1";
}

function linkContext(db: RunnerDatabase, handoff: HandoffRecord): HandoffLinkContext {
  const runs = handoff.run_ids.flatMap((id) => {
    const run = getRun(db, id);
    return run ? [{ id: run.id, work_id: run.work_id }] : [];
  });
  const evidence = handoff.evidence_ids.flatMap((id) => {
    const stored = getStoredEvidence(db, id);
    return stored ? [{ id: stored.evidence.id, status: stored.evidence.status, work_id: stored.evidence.work_id }] : [];
  });
  return { evidence, runs };
}

function handoffListQuery(filter: HandoffListFilter): {
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

function handoffListWhere(
  filter: Omit<HandoffListFilter, "limit">
): { args: Array<number | string>; clauses: string[] } {
  const placeholders = HANDOFF_RECORD_EVENT_TYPES.map(() => "?").join(", ");
  const clauses = [
    `event.type in (${placeholders})`,
    "json_valid(event.payload)",
    `not exists (
      select 1 from issue_events newer
      where newer.type in (${placeholders}) and json_valid(newer.payload)
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
  addFilter(clauses, args, "json_extract(event.payload, '$.handoff.work_id')=?", filter.work_id);
  addListFilter(clauses, args, "json_extract(event.payload, '$.handoff.status')", filter.statuses);
  addListFilter(clauses, args, "json_extract(event.payload, '$.handoff.delivery.mode')", filter.delivery_modes);
  return { args, clauses };
}

function storedHandoff(row: HandoffEventRow): StoredHandoffRecord | null {
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

function projectIDForIssue(db: RunnerDatabase, issueID: number): string {
  const row = db.sqlite.query<{ project_id: string }, [number]>(
    "select project_id from issues where id=?"
  ).get(issueID);
  if (!row) throw new Error("Handoff Issue not found");
  return requiredText(row.project_id, "Handoff project id");
}

function assertIssueBackedWork(issueID: number, workID: string): void {
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

function canonicalTimestamp(value: unknown, label: string): string {
  const text = requiredText(value, label);
  const timestamp = new Date(text);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== text) throw new Error(`${label} must be canonical ISO`);
  return text;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

function requiredText(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") throw new Error(`${label} is required`);
  return text;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
