import type { RunnerDatabase } from "../../database.ts";
import {
  cleanString,
  integerInput,
  integerValue,
  now,
  optionalString,
  requiredString,
  requireCreateFields,
  type PatchInput
} from "./common.ts";
import { redactAuditJsonText } from "./auditRedaction.ts";

export type IssueSupervisorEvent = {
  action_id: string; action_type: string; confidence: string; created_at: string;
  decision: string; diagnosis_code: string; event_type: string; id: number; issue_id: number;
  payload_json: string; project_id: string; provider: string; provider_error_category: string;
  provider_session_id: string; provider_turn_id: string; retry_after_at: string; run_id: string;
};
export type IssueSupervisorEventInput = PatchInput<IssueSupervisorEvent>;
export type IssueSupervisorEventFilter = {
  actionId?: string;
  createdAfter?: string;
  createdBefore?: string;
  eventType?: string;
  eventTypes?: string[];
  issueId?: number;
  latestLimit?: number;
  projectId?: string;
  retryAfterOnly?: boolean;
};
export type IssueSupervisorEventSummary = {
  actions: number;
  decisions: number;
  exhausted_recoveries: number;
  needs_user_escalations: number;
  rate_limit_waits: number;
  recovered_issues: number;
  results: number;
  signals: number;
};

const TABLE = "issue_supervisor_events";
const COLUMNS = `id, issue_id, project_id, run_id, provider, provider_session_id,
  provider_turn_id, event_type, diagnosis_code, provider_error_category,
  retry_after_at, decision, confidence, action_id, action_type, payload_json, created_at`;

export function createIssueSupervisorEvent(
  db: RunnerDatabase,
  input: IssueSupervisorEventInput
): IssueSupervisorEvent {
  const record = normalizeCreate(input);
  requireCreateFields(record, ["event_type"]);
  db.sqlite.run(`insert into ${TABLE} (${insertColumns()}) values (${placeholders(16)})`, [
    record.issue_id, record.project_id, record.run_id, record.provider,
    record.provider_session_id, record.provider_turn_id, record.event_type,
    record.diagnosis_code, record.provider_error_category, record.retry_after_at,
    record.decision, record.confidence, record.action_id, record.action_type,
    record.payload_json, now()
  ]);
  return mustGetIssueSupervisorEvent(db, lastInsertID(db));
}

export function listIssueSupervisorEvents(
  db: RunnerDatabase,
  filter: IssueSupervisorEventFilter = {}
): IssueSupervisorEvent[] {
  const conditions: string[] = [];
  const args: Array<string | number> = [];
  addFilter(conditions, args, "project_id=?", filter.projectId);
  addFilter(conditions, args, "issue_id=?", filter.issueId);
  addFilter(conditions, args, "event_type=?", filter.eventType);
  addFilter(conditions, args, "action_id=?", filter.actionId);
  addFilter(conditions, args, "created_at>=?", filter.createdAfter);
  addFilter(conditions, args, "created_at<=?", filter.createdBefore);
  const eventTypes = [...new Set((filter.eventTypes ?? []).map(cleanString).filter(Boolean))];
  if (eventTypes.length > 0) {
    conditions.push(`event_type in (${eventTypes.map(() => "?").join(", ")})`);
    args.push(...eventTypes);
  }
  if (filter.retryAfterOnly) conditions.push("retry_after_at<>''");
  const latestLimit = boundedLatestLimit(filter.latestLimit);
  if (latestLimit !== undefined) args.push(latestLimit);
  const rows = db.sqlite.query<Record<string, unknown>, Array<string | number>>(
    `select ${COLUMNS} from ${TABLE}
     ${conditions.length > 0 ? `where ${conditions.join(" and ")}` : ""}
     order by created_at ${latestLimit === undefined ? "asc" : "desc"}, id ${latestLimit === undefined ? "asc" : "desc"}
     ${latestLimit === undefined ? "" : "limit ?"}`
  ).all(...args).map(mapIssueSupervisorEvent);
  return latestLimit === undefined ? rows : rows.reverse();
}

export function summarizeIssueSupervisorEvents(
  db: RunnerDatabase,
  issueID: number
): IssueSupervisorEventSummary {
  const row = db.sqlite.query<Record<string, unknown>, [number]>(`
    select
      sum(case when event_type='action' then 1 else 0 end) as actions,
      sum(case when event_type like '%decision%' then 1 else 0 end) as decisions,
      sum(case when diagnosis_code='session_recovery_exhausted' then 1 else 0 end) as exhausted_recoveries,
      sum(case when action_type='needs_user.escalate' or decision in ('needs_user', 'blocked') then 1 else 0 end)
        as needs_user_escalations,
      sum(case when action_type='issue.retry_after' or retry_after_at<>'' or provider_error_category='rate_limit'
        then 1 else 0 end) as rate_limit_waits,
      max(case when event_type='action' and action_type in ('session.resume_followup', 'session.steer', 'issue.retry')
        then 1 else 0 end) as recovered_issues,
      sum(case when event_type='result' then 1 else 0 end) as results,
      sum(case when event_type='signal' then 1 else 0 end) as signals
    from ${TABLE}
    where issue_id=?
  `).get(issueID) ?? {};
  return {
    actions: countValue(row.actions),
    decisions: countValue(row.decisions),
    exhausted_recoveries: countValue(row.exhausted_recoveries),
    needs_user_escalations: countValue(row.needs_user_escalations),
    rate_limit_waits: countValue(row.rate_limit_waits),
    recovered_issues: countValue(row.recovered_issues),
    results: countValue(row.results),
    signals: countValue(row.signals)
  };
}

function addFilter(
  conditions: string[],
  args: Array<string | number>,
  condition: string,
  value: string | number | undefined
): void {
  const normalized = typeof value === "number" ? value : cleanString(value);
  if (normalized === "") return;
  conditions.push(condition);
  args.push(normalized);
}

function boundedLatestLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 500) {
    throw new Error("latest supervisor event limit must be between 1 and 500");
  }
  return value;
}

function countValue(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function mustGetIssueSupervisorEvent(db: RunnerDatabase, id: number): IssueSupervisorEvent {
  const row = db.sqlite.query<Record<string, unknown>, [number]>(
    `select ${COLUMNS} from ${TABLE} where id=?`
  ).get(id);
  if (!row) throw new Error("issue supervisor event missing after write");
  return mapIssueSupervisorEvent(row);
}

function normalizeCreate(input: IssueSupervisorEventInput): IssueSupervisorEvent {
  return {
    action_id: cleanString(input.action_id),
    action_type: cleanString(input.action_type),
    confidence: cleanString(input.confidence),
    created_at: "",
    decision: cleanString(input.decision),
    diagnosis_code: cleanString(input.diagnosis_code),
    event_type: cleanString(input.event_type),
    id: 0,
    issue_id: integerInput(input.issue_id),
    payload_json: payloadText(input.payload_json),
    project_id: cleanString(input.project_id),
    provider: cleanString(input.provider),
    provider_error_category: cleanString(input.provider_error_category),
    provider_session_id: cleanString(input.provider_session_id),
    provider_turn_id: cleanString(input.provider_turn_id),
    retry_after_at: cleanString(input.retry_after_at),
    run_id: cleanString(input.run_id)
  };
}

function mapIssueSupervisorEvent(row: Record<string, unknown>): IssueSupervisorEvent {
  return {
    action_id: optionalString(row.action_id),
    action_type: optionalString(row.action_type),
    confidence: optionalString(row.confidence),
    created_at: requiredString(row.created_at, "issue_supervisor_events.created_at"),
    decision: optionalString(row.decision),
    diagnosis_code: optionalString(row.diagnosis_code),
    event_type: requiredString(row.event_type, "issue_supervisor_events.event_type"),
    id: integerValue(row.id, "issue_supervisor_events.id"),
    issue_id: integerValue(row.issue_id, "issue_supervisor_events.issue_id"),
    payload_json: redactAuditJsonText(optionalString(row.payload_json) || "{}"),
    project_id: optionalString(row.project_id),
    provider: optionalString(row.provider),
    provider_error_category: optionalString(row.provider_error_category),
    provider_session_id: optionalString(row.provider_session_id),
    provider_turn_id: optionalString(row.provider_turn_id),
    retry_after_at: optionalString(row.retry_after_at),
    run_id: optionalString(row.run_id)
  };
}

function payloadText(value: unknown): string {
  if (typeof value === "string") return redactAuditJsonText(value || "{}");
  return redactAuditJsonText(JSON.stringify(value ?? {}));
}

function lastInsertID(db: RunnerDatabase): number {
  return db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0;
}

function insertColumns(): string {
  return `issue_id, project_id, run_id, provider, provider_session_id, provider_turn_id,
    event_type, diagnosis_code, provider_error_category, retry_after_at, decision,
    confidence, action_id, action_type, payload_json, created_at`;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
