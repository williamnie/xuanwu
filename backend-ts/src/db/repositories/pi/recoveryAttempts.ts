import type { RunnerDatabase } from "../../database.ts";
import {
  buildFilter,
  cleanString,
  integerInput,
  integerValue,
  jsonText,
  listRows,
  now,
  optionalString,
  requiredString,
  type PatchInput
} from "./common.ts";
import { redactAuditJsonText, redactAuditText } from "./auditRedaction.ts";

export type PiRecoveryAttempt = {
  action_type: string; after_snapshot_json: string; before_snapshot_json: string;
  budget_window_started_at: string; created_at: string; diagnosis_code: string;
  error: string; executing_started_at: string; expected_provider_turn_id: string;
  hard_timeout_at: string; id: string; idempotency_key: string; ignored_reasons_json: string;
  issue_id: number; progress_detected: number; progress_reasons_json: string;
  project_id: string; provider_session_id: string; provider_turn_id: string;
  result_provider_turn_id: string; run_group_id: string; run_id: string; session_id: string;
  source_decision_id: string; status: PiRecoveryAttemptStatus; updated_at: string;
};
export type PiRecoveryAttemptInput = PatchInput<PiRecoveryAttempt>;
export type PiRecoveryAttemptStatus =
  "planned" | "executing" | "progress" | "no_progress" | "failed" | "cancelled" | "superseded";
export type PiRecoveryAttemptFilter = {
  actionType?: string; issueId?: number; projectId?: string; sessionId?: string; status?: string;
};
export type PiRecoveryResumeTurnFilter = {
  expectedProviderTurnID: string; issueID: number; providerSessionID: string;
};
export type PiRecoveryAttemptCountFilter = {
  actionType?: string; issueId?: number; projectId?: string; sessionId?: string; since: string;
  statuses?: PiRecoveryAttemptStatus[];
};
export type PiRecoveryAttemptWindowFilter = PiRecoveryAttemptCountFilter;
export type PiRecoveryAttemptStatusPatch = {
  after_snapshot_json?: unknown; error?: string; executing_started_at?: string;
  hard_timeout_at?: string; ignored_reasons_json?: unknown; progress_detected?: number;
  progress_reasons_json?: unknown; result_provider_turn_id?: string; status: PiRecoveryAttemptStatus;
};
type NormalizedStatusPatch = {
  after_snapshot_json?: string; error?: string; executing_started_at?: string;
  hard_timeout_at?: string; ignored_reasons_json?: string; progress_detected?: number;
  progress_reasons_json?: string; result_provider_turn_id?: string; status: PiRecoveryAttemptStatus;
};

type SQLValue = string | number;
const TABLE = "pi_recovery_attempts";
const COLUMNS = `id, idempotency_key, source_decision_id, project_id, issue_id,
  run_id, session_id, provider_session_id, provider_turn_id, expected_provider_turn_id,
  result_provider_turn_id, run_group_id, diagnosis_code, action_type, status,
  executing_started_at, hard_timeout_at, progress_detected, progress_reasons_json,
  ignored_reasons_json, budget_window_started_at, before_snapshot_json, after_snapshot_json,
  error, created_at, updated_at`;
const STATUSES = new Set<PiRecoveryAttemptStatus>([
  "planned", "executing", "progress", "no_progress", "failed", "cancelled", "superseded"
]);

export function recordPiRecoveryAttempt(db: RunnerDatabase, input: PiRecoveryAttemptInput): PiRecoveryAttempt {
  const record = normalizeCreate(input);
  const existing = findByIDOrKey(db, record.id, record.idempotency_key);
  if (existing) return existing;
  db.sqlite.run(`insert or ignore into ${TABLE} (${COLUMNS}) values (${placeholders(26)})`, [
    record.id, record.idempotency_key, record.source_decision_id, record.project_id,
    record.issue_id, record.run_id, record.session_id, record.provider_session_id,
    record.provider_turn_id, record.expected_provider_turn_id, record.result_provider_turn_id,
    record.run_group_id, record.diagnosis_code, record.action_type, record.status,
    record.executing_started_at, record.hard_timeout_at, record.progress_detected,
    record.progress_reasons_json, record.ignored_reasons_json, record.budget_window_started_at,
    record.before_snapshot_json, record.after_snapshot_json, record.error,
    record.created_at, record.updated_at
  ]);
  const saved = findByIDOrKey(db, record.id, record.idempotency_key);
  if (!saved) throw new Error("PI recovery attempt missing after write");
  return saved;
}

export function getPiRecoveryAttempt(db: RunnerDatabase, id: string): PiRecoveryAttempt | null {
  return findByIDOrKey(db, cleanString(id), "");
}

export function listPiRecoveryAttempts(
  db: RunnerDatabase,
  filter: PiRecoveryAttemptFilter = {}
): PiRecoveryAttempt[] {
  return listRows(db, TABLE, COLUMNS, mapAttempt, buildFilter([
    ["project_id=?", filter.projectId], ["issue_id=?", filter.issueId],
    ["session_id=?", filter.sessionId], ["action_type=?", filter.actionType], ["status=?", filter.status]
  ], "created_at asc, id asc"));
}

export function listPiRecoveryAttemptsForResumeTurn(
  db: RunnerDatabase,
  filter: PiRecoveryResumeTurnFilter
): PiRecoveryAttempt[] {
  const rows = db.sqlite.query<Record<string, unknown>, [number, string, string]>(
    `select ${COLUMNS} from ${TABLE}
      where issue_id=? and action_type='session.resume_followup'
        and provider_session_id=? and expected_provider_turn_id=?
      order by created_at desc, id desc`
  ).all(
    integerInput(filter.issueID),
    cleanString(filter.providerSessionID),
    cleanString(filter.expectedProviderTurnID)
  );
  return rows.map(mapAttempt);
}

export function updatePiRecoveryAttemptStatus(
  db: RunnerDatabase,
  id: string,
  input: PiRecoveryAttemptStatusPatch
): PiRecoveryAttempt {
  const current = requireAttempt(db, id);
  const patch = normalizeStatusPatch(input);
  db.sqlite.run(`update ${TABLE} set status=?, executing_started_at=?, hard_timeout_at=?,
    progress_detected=?, progress_reasons_json=?, ignored_reasons_json=?,
    result_provider_turn_id=?, after_snapshot_json=?, error=?, updated_at=? where id=?`, [
    patch.status, patch.executing_started_at ?? current.executing_started_at,
    patch.hard_timeout_at ?? current.hard_timeout_at,
    patch.progress_detected ?? current.progress_detected,
    patch.progress_reasons_json ?? current.progress_reasons_json,
    patch.ignored_reasons_json ?? current.ignored_reasons_json,
    cleanString(patch.result_provider_turn_id) || current.result_provider_turn_id,
    patch.after_snapshot_json ?? current.after_snapshot_json,
    cleanString(patch.error) || current.error, now(), current.id
  ]);
  return requireAttempt(db, current.id);
}

export function latestPiRecoveryAttemptForAction(
  db: RunnerDatabase,
  input: { actionID: string; issueID: number }
): PiRecoveryAttempt | null {
  const actionID = cleanString(input.actionID);
  if (actionID === "") return null;
  const row = db.sqlite.query<Record<string, unknown>, [number, string, string]>(
    `select ${COLUMNS} from ${TABLE}
      where issue_id=? and (source_decision_id=? or idempotency_key like ? escape '\\')
      order by created_at desc, id desc limit 1`
  ).get(integerInput(input.issueID), actionID, `%${escapeLike(actionID)}%`);
  return row ? mapAttempt(row) : null;
}

export function countPiRecoveryAttempts(db: RunnerDatabase, filter: PiRecoveryAttemptCountFilter): number {
  const query = windowQuery(filter);
  const row = db.sqlite.query<{ count: number }, SQLValue[]>(
    `select count(*) as count from ${TABLE} where ${query.where}`
  ).get(...query.args);
  return row?.count ?? 0;
}

export function firstPiRecoveryAttemptCreatedAt(
  db: RunnerDatabase,
  filter: PiRecoveryAttemptWindowFilter
): string {
  const query = windowQuery(filter);
  const row = db.sqlite.query<{ created_at: string }, SQLValue[]>(
    `select created_at from ${TABLE} where ${query.where} order by created_at asc, id asc limit 1`
  ).get(...query.args);
  return cleanString(row?.created_at);
}

function windowQuery(filter: PiRecoveryAttemptWindowFilter): { args: SQLValue[]; where: string } {
  const conditions = ["created_at>=?"];
  const args: SQLValue[] = [requiredString(filter.since, "since")];
  addCondition(conditions, args, "project_id=?", filter.projectId);
  addCondition(conditions, args, "issue_id=?", filter.issueId);
  addCondition(conditions, args, "session_id=?", filter.sessionId);
  addCondition(conditions, args, "action_type=?", filter.actionType);
  const statuses = cleanStatuses(filter.statuses);
  if (statuses.length > 0) {
    conditions.push(`status in (${placeholders(statuses.length)})`);
    args.push(...statuses);
  }
  return { args, where: conditions.join(" and ") };
}

function normalizeCreate(input: PiRecoveryAttemptInput): PiRecoveryAttempt {
  const timestamp = now();
  const createdAt = cleanString(input.created_at) || timestamp;
  return {
    action_type: requiredString(input.action_type, "action_type"),
    after_snapshot_json: redactedJsonPayload(input.after_snapshot_json, "{}"),
    before_snapshot_json: redactedJsonPayload(input.before_snapshot_json, "{}"),
    budget_window_started_at: requiredString(input.budget_window_started_at, "budget_window_started_at"),
    created_at: createdAt, diagnosis_code: requiredString(input.diagnosis_code, "diagnosis_code"),
    error: redactAuditText(cleanString(input.error)), executing_started_at: cleanString(input.executing_started_at),
    expected_provider_turn_id: cleanString(input.expected_provider_turn_id),
    hard_timeout_at: cleanString(input.hard_timeout_at), id: cleanString(input.id) || crypto.randomUUID(),
    idempotency_key: requiredString(input.idempotency_key, "idempotency_key"),
    ignored_reasons_json: jsonPayload(input.ignored_reasons_json, "[]"),
    issue_id: integerInput(input.issue_id), progress_detected: integerInput(input.progress_detected),
    progress_reasons_json: jsonPayload(input.progress_reasons_json, "[]"),
    project_id: cleanString(input.project_id), provider_session_id: cleanString(input.provider_session_id),
    provider_turn_id: cleanString(input.provider_turn_id),
    result_provider_turn_id: cleanString(input.result_provider_turn_id), run_group_id: cleanString(input.run_group_id),
    run_id: cleanString(input.run_id), session_id: cleanString(input.session_id),
    source_decision_id: cleanString(input.source_decision_id), status: attemptStatus(input.status, "planned"),
    updated_at: cleanString(input.updated_at) || timestamp
  };
}

function normalizeStatusPatch(input: PiRecoveryAttemptStatusPatch): NormalizedStatusPatch {
  return {
    after_snapshot_json: input.after_snapshot_json === undefined ? undefined : redactedJsonPayload(input.after_snapshot_json, "{}"),
    error: input.error === undefined ? undefined : redactAuditText(cleanString(input.error)),
    executing_started_at: input.executing_started_at,
    hard_timeout_at: input.hard_timeout_at, ignored_reasons_json: input.ignored_reasons_json === undefined
      ? undefined : jsonPayload(input.ignored_reasons_json, "[]"),
    progress_detected: input.progress_detected === undefined ? undefined : integerInput(input.progress_detected),
    progress_reasons_json: input.progress_reasons_json === undefined ? undefined : jsonPayload(input.progress_reasons_json, "[]"),
    result_provider_turn_id: input.result_provider_turn_id, status: attemptStatus(input.status)
  };
}

function mapAttempt(row: Record<string, unknown>): PiRecoveryAttempt {
  return {
    action_type: requiredString(row.action_type, `${TABLE}.action_type`),
    after_snapshot_json: optionalString(row.after_snapshot_json) || "{}",
    before_snapshot_json: optionalString(row.before_snapshot_json) || "{}",
    budget_window_started_at: requiredString(row.budget_window_started_at, `${TABLE}.budget_window_started_at`),
    created_at: requiredString(row.created_at, `${TABLE}.created_at`),
    diagnosis_code: requiredString(row.diagnosis_code, `${TABLE}.diagnosis_code`),
    error: optionalString(row.error), executing_started_at: optionalString(row.executing_started_at),
    expected_provider_turn_id: optionalString(row.expected_provider_turn_id),
    hard_timeout_at: optionalString(row.hard_timeout_at), id: requiredString(row.id, `${TABLE}.id`),
    idempotency_key: requiredString(row.idempotency_key, `${TABLE}.idempotency_key`),
    ignored_reasons_json: optionalString(row.ignored_reasons_json) || "[]",
    issue_id: integerValue(row.issue_id, `${TABLE}.issue_id`),
    progress_detected: integerValue(row.progress_detected, `${TABLE}.progress_detected`),
    progress_reasons_json: optionalString(row.progress_reasons_json) || "[]",
    project_id: optionalString(row.project_id), provider_session_id: optionalString(row.provider_session_id),
    provider_turn_id: optionalString(row.provider_turn_id), result_provider_turn_id: optionalString(row.result_provider_turn_id),
    run_group_id: optionalString(row.run_group_id), run_id: optionalString(row.run_id),
    session_id: optionalString(row.session_id), source_decision_id: optionalString(row.source_decision_id),
    status: attemptStatus(row.status), updated_at: requiredString(row.updated_at, `${TABLE}.updated_at`)
  };
}

function findByIDOrKey(db: RunnerDatabase, id: string, key: string): PiRecoveryAttempt | null {
  if (id === "" && key === "") return null;
  const row = db.sqlite.query<Record<string, unknown>, [string, string]>(
    `select ${COLUMNS} from ${TABLE} where id=? or idempotency_key=? limit 1`
  ).get(id, key);
  return row ? mapAttempt(row) : null;
}

function requireAttempt(db: RunnerDatabase, id: string): PiRecoveryAttempt {
  const attempt = getPiRecoveryAttempt(db, id);
  if (!attempt) throw new Error(`PI recovery attempt ${cleanString(id)} not found`);
  return attempt;
}

function addCondition(conditions: string[], args: SQLValue[], clause: string, value: string | number | undefined): void {
  const normalized = typeof value === "number" ? value : cleanString(value);
  if (normalized === "") return;
  conditions.push(clause);
  args.push(normalized);
}

function cleanStatuses(statuses: PiRecoveryAttemptStatus[] | undefined): PiRecoveryAttemptStatus[] {
  return (statuses ?? []).map((status) => attemptStatus(status));
}

function attemptStatus(value: unknown, fallback?: PiRecoveryAttemptStatus): PiRecoveryAttemptStatus {
  const status = cleanString(value) || fallback || "";
  if (STATUSES.has(status as PiRecoveryAttemptStatus)) return status as PiRecoveryAttemptStatus;
  throw new Error(`invalid PI recovery attempt status ${status}`);
}

function jsonPayload(value: unknown, fallback: string): string {
  if (typeof value === "string") return jsonText(value, fallback);
  return JSON.stringify(value ?? JSON.parse(fallback));
}

function redactedJsonPayload(value: unknown, fallback: string): string {
  return redactAuditJsonText(jsonPayload(value, fallback));
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
