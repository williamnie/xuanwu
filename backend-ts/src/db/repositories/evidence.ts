import type { RunnerDatabase } from "../database.ts";
import { validateEvidence, type EvidenceRecord } from "../../domain/evidence/contracts.ts";
import { recordIssueEvent } from "./issueEvents.ts";

export const EVIDENCE_RECORDED_EVENT_TYPE = "evidence.recorded.v1";
export const LEGACY_HUMAN_EVIDENCE_EVENT_TYPE = "issue.verification_human_evidence.v1";

export type EvidenceStorageSource = "structured" | "legacy_human";

export type StoredEvidenceRecord = {
  evidence: EvidenceRecord;
  event_id: number;
  issue_id: number;
  project_id: string;
  storage_source: EvidenceStorageSource;
};

export type EvidenceListFilter = {
  before_event_id?: number;
  issue_ids?: number[];
  kinds?: string[];
  limit: number;
  match_none?: boolean;
  project_id?: string;
  run_ids?: string[];
  statuses?: string[];
  work_id?: string;
};

export type EvidenceListPage = {
  has_more: boolean;
  items: StoredEvidenceRecord[];
  next_before_event_id?: number;
  skipped_invalid: number;
};

type EvidenceEventRow = {
  event_id: number;
  issue_id: number;
  payload: string;
  project_id: string;
  type: string;
};

type EvidenceWriteContext = {
  recorded_at: string;
  source: string;
};

export function recordEvidenceRecords(
  db: RunnerDatabase,
  issueID: number,
  records: readonly EvidenceRecord[],
  context: EvidenceWriteContext
): void {
  for (const evidence of records) {
    const validation = validateEvidence(evidence);
    if (!validation.ok) {
      throw new Error(`cannot persist invalid Evidence ${evidence.id}: ${validation.errors.join("; ")}`);
    }
    if (issueIDFromWorkID(evidence.work_id) !== issueID) {
      throw new Error(`Evidence ${evidence.id} belongs to another Issue-backed Work`);
    }
    const existing = getStructuredEvidence(db, evidence.id);
    if (existing) {
      if (stableJson(existing.evidence) !== stableJson(evidence)) {
        throw new Error(`Evidence ${evidence.id} conflicts with the append-only structured record`);
      }
      continue;
    }
    recordIssueEvent(db, issueID, EVIDENCE_RECORDED_EVENT_TYPE, {
      evidence,
      recorded_at: context.recorded_at,
      source: context.source
    });
  }
}

export function listStoredEvidence(db: RunnerDatabase, filter: EvidenceListFilter): EvidenceListPage {
  if (filter.match_none) return { has_more: false, items: [], skipped_invalid: 0 };
  const query = evidenceListQuery(filter);
  const rows = db.sqlite.query<EvidenceEventRow, Array<number | string>>(query.sql).all(...query.args);
  const seen = new Set<string>();
  const records: StoredEvidenceRecord[] = [];
  let skippedInvalid = 0;
  for (const row of rows) {
    const stored = storedEvidence(row);
    if (!stored) {
      skippedInvalid += 1;
      continue;
    }
    if (seen.has(stored.evidence.id)) continue;
    seen.add(stored.evidence.id);
    records.push(stored);
  }

  const hasMore = records.length > filter.limit || rows.length === query.row_limit;
  const items = records.slice(0, filter.limit);
  const cursorRow = records.length > filter.limit
    ? records[filter.limit - 1]
    : hasMore ? rows.at(-1) : undefined;
  return {
    has_more: hasMore,
    items,
    ...(cursorRow ? { next_before_event_id: cursorRow.event_id } : {}),
    skipped_invalid: skippedInvalid
  };
}

export function getStoredEvidence(db: RunnerDatabase, evidenceID: string): StoredEvidenceRecord | null {
  const rows = db.sqlite.query<EvidenceEventRow, [string, string, string, string]>(`
    select event.id as event_id, event.issue_id, event.type, event.payload, issue.project_id
    from issue_events event
    join issues issue on issue.id=event.issue_id
    where event.type in (?, ?)
      and json_valid(event.payload)
      and json_extract(event.payload, '$.evidence.id')=?
    order by case when event.type=? then 0 else 1 end, event.id desc
    limit 20
  `).all(
    EVIDENCE_RECORDED_EVENT_TYPE,
    LEGACY_HUMAN_EVIDENCE_EVENT_TYPE,
    evidenceID,
    EVIDENCE_RECORDED_EVENT_TYPE
  );
  for (const row of rows) {
    const stored = storedEvidence(row);
    if (stored) return stored;
  }
  return null;
}

export function issueIDForEvidenceSourceEvent(db: RunnerDatabase, eventID: number): number | null {
  return db.sqlite.query<{ issue_id: number }, [number]>(
    "select issue_id from issue_events where id=?"
  ).get(eventID)?.issue_id ?? null;
}

export function issueIDsForRun(db: RunnerDatabase, runID: string): number[] {
  return db.sqlite.query<{ issue_id: number }, [string]>(
    "select issue_id from issue_runs where run_id=?"
  ).all(runID).map((row) => row.issue_id);
}

export function issueIDsForSession(db: RunnerDatabase, sessionRef: string): number[] {
  const normalized = sessionRef.trim();
  if (normalized === "") return [];
  const separator = normalized.indexOf(":");
  const provider = separator > 0 ? normalized.slice(0, separator) : "";
  const providerSessionID = separator > 0 ? normalized.slice(separator + 1) : normalized;
  const rows = db.sqlite.query<{ issue_id: number }, Array<string>>(`
    select distinct run.issue_id
    from run_attempts attempt
    join issue_runs run on run.id=attempt.issue_run_id
    where attempt.agent_session_key=?
      or attempt.provider_session_id=?
      or (attempt.provider || ':' || attempt.provider_session_id)=?
      ${provider ? "or (attempt.provider=? and attempt.provider_session_id=?)" : ""}
  `).all(
    normalized,
    providerSessionID,
    normalized,
    ...(provider ? [provider, providerSessionID] : [])
  );
  return uniqueNumbers(rows.map((row) => row.issue_id));
}

export function runIDsForSession(db: RunnerDatabase, sessionRef: string): string[] {
  const normalized = sessionRef.trim();
  if (normalized === "") return [];
  const separator = normalized.indexOf(":");
  const provider = separator > 0 ? normalized.slice(0, separator) : "";
  const providerSessionID = separator > 0 ? normalized.slice(separator + 1) : normalized;
  const rows = db.sqlite.query<{ run_id: string }, Array<string>>(`
    select distinct attempt.run_id
    from run_attempts attempt
    where attempt.agent_session_key=?
      or attempt.provider_session_id=?
      or (attempt.provider || ':' || attempt.provider_session_id)=?
      ${provider ? "or (attempt.provider=? and attempt.provider_session_id=?)" : ""}
  `).all(
    normalized,
    providerSessionID,
    normalized,
    ...(provider ? [provider, providerSessionID] : [])
  );
  return [...new Set(rows.map((row) => row.run_id).filter(Boolean))];
}

function getStructuredEvidence(db: RunnerDatabase, evidenceID: string): StoredEvidenceRecord | null {
  const rows = db.sqlite.query<EvidenceEventRow, [string, string]>(`
    select event.id as event_id, event.issue_id, event.type, event.payload, issue.project_id
    from issue_events event
    join issues issue on issue.id=event.issue_id
    where event.type=? and json_valid(event.payload)
      and json_extract(event.payload, '$.evidence.id')=?
    order by event.id desc limit 2
  `).all(EVIDENCE_RECORDED_EVENT_TYPE, evidenceID);
  for (const row of rows) {
    const stored = storedEvidence(row);
    if (stored) return stored;
  }
  return null;
}

function evidenceListQuery(filter: EvidenceListFilter): {
  args: Array<number | string>;
  row_limit: number;
  sql: string;
} {
  const clauses = [
    `(event.type=? or (event.type=? and not exists (
      select 1 from issue_events structured
      where structured.type=? and json_valid(structured.payload)
        and json_extract(structured.payload, '$.evidence.id')=json_extract(event.payload, '$.evidence.id')
    )))`,
    "json_valid(event.payload)"
  ];
  const args: Array<number | string> = [
    EVIDENCE_RECORDED_EVENT_TYPE,
    LEGACY_HUMAN_EVIDENCE_EVENT_TYPE,
    EVIDENCE_RECORDED_EVENT_TYPE
  ];
  if (filter.before_event_id !== undefined) addFilter(clauses, args, "event.id < ?", filter.before_event_id);
  addFilter(clauses, args, "issue.project_id=?", filter.project_id);
  addFilter(clauses, args, "json_extract(event.payload, '$.evidence.work_id')=?", filter.work_id);
  addListFilter(clauses, args, "event.issue_id", filter.issue_ids);
  addListFilter(clauses, args, "json_extract(event.payload, '$.evidence.run_id')", filter.run_ids);
  addListFilter(clauses, args, "json_extract(event.payload, '$.evidence.kind')", filter.kinds);
  addListFilter(clauses, args, "json_extract(event.payload, '$.evidence.status')", filter.statuses);
  const rowLimit = Math.min(filter.limit * 8 + 1, 1001);
  args.push(rowLimit);
  return {
    args,
    row_limit: rowLimit,
    sql: `select event.id as event_id, event.issue_id, event.type, event.payload, issue.project_id
      from issue_events event
      join issues issue on issue.id=event.issue_id
      where ${clauses.join(" and ")}
      order by event.id desc limit ?`
  };
}

function storedEvidence(row: EvidenceEventRow): StoredEvidenceRecord | null {
  try {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const evidence = payload.evidence;
    const validation = validateEvidence(evidence);
    if (!validation.ok) return null;
    return {
      evidence: evidence as EvidenceRecord,
      event_id: row.event_id,
      issue_id: row.issue_id,
      project_id: row.project_id,
      storage_source: row.type === EVIDENCE_RECORDED_EVENT_TYPE ? "structured" : "legacy_human"
    };
  } catch {
    return null;
  }
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
  values: readonly (number | string)[] | undefined
): void {
  const normalized = [...new Set(values ?? [])];
  if (normalized.length === 0) return;
  clauses.push(`${expression} in (${normalized.map(() => "?").join(", ")})`);
  args.push(...normalized);
}

function issueIDFromWorkID(workID: string): number | null {
  const match = /^xw:work:issues:([1-9][0-9]*)$/.exec(workID);
  return match ? Number(match[1]) : null;
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isSafeInteger(value) && value > 0))];
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
