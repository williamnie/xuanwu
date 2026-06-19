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

export type PiGuardianAlert = {
  alert_type: string; created_at: string; direct_feishu_error: string;
  direct_feishu_message_id: string; direct_feishu_state: string; evidence_json: string;
  id: string; issue_id: number; max_retry_count: number; message: string;
  next_retry_at: string; project_id: string; retry_count: number; run_group_id: string;
  severity: string; status: PiGuardianAlertStatus; ui_visible: number;
  updated_at: string; watchdog_seen_at: string;
};
export type PiGuardianAlertInput = PatchInput<PiGuardianAlert>;
export type PiGuardianAlertStatus = "acked" | "open" | "resolved" | "suppressed";
export type PiGuardianAlertFilter = {
  alertType?: string; projectId?: string; status?: string;
};
export type PiGuardianAlertRetryInput = {
  direct_feishu_error?: string; max_retry_count?: number; next_retry_at?: string;
};

type SQLValue = string | number;
const TABLE = "pi_guardian_alerts";
const COLUMNS = `id, alert_type, severity, status, project_id, issue_id,
  run_group_id, message, evidence_json, ui_visible, direct_feishu_state,
  direct_feishu_message_id, direct_feishu_error, next_retry_at, retry_count,
  max_retry_count, watchdog_seen_at, created_at, updated_at`;
const UPDATE_COLUMNS = [
  "severity", "status", "message", "evidence_json", "ui_visible",
  "direct_feishu_state", "direct_feishu_message_id", "direct_feishu_error",
  "next_retry_at", "retry_count", "max_retry_count", "watchdog_seen_at"
] as const;
const STATUSES = new Set<PiGuardianAlertStatus>(["open", "acked", "resolved", "suppressed"]);

export function upsertPiGuardianAlert(
  db: RunnerDatabase,
  input: PiGuardianAlertInput
): PiGuardianAlert {
  const record = normalizeCreate(input);
  const existing = findOpenAlert(db, record);
  if (existing) return refreshPiGuardianAlert(db, existing.id, record);
  db.sqlite.run(`insert into ${TABLE} (${COLUMNS}) values (${placeholders(19)})`, [
    record.id, record.alert_type, record.severity, record.status,
    record.project_id, record.issue_id, record.run_group_id, record.message,
    record.evidence_json, record.ui_visible, record.direct_feishu_state,
    record.direct_feishu_message_id, record.direct_feishu_error,
    record.next_retry_at, record.retry_count, record.max_retry_count,
    record.watchdog_seen_at, record.created_at, record.updated_at
  ]);
  return requirePiGuardianAlert(db, record.id);
}

export function getPiGuardianAlert(db: RunnerDatabase, id: string): PiGuardianAlert | null {
  const key = cleanString(id);
  if (key === "") return null;
  const row = db.sqlite.query<Record<string, unknown>, [string]>(
    `select ${COLUMNS} from ${TABLE} where id=?`
  ).get(key);
  return row ? mapAlert(row) : null;
}

export function listPiGuardianAlerts(
  db: RunnerDatabase,
  filter: PiGuardianAlertFilter = {}
): PiGuardianAlert[] {
  return listRows(db, TABLE, COLUMNS, mapAlert, buildFilter([
    ["project_id=?", filter.projectId],
    ["status=?", filter.status],
    ["alert_type=?", filter.alertType]
  ], "created_at desc, id asc"));
}

export function updatePiGuardianAlert(
  db: RunnerDatabase,
  id: string,
  input: PiGuardianAlertInput
): PiGuardianAlert {
  const patch = normalizePatch(input);
  const columns = UPDATE_COLUMNS.filter((column) => patch[column] !== undefined);
  if (columns.length > 0) {
    db.sqlite.run(`update ${TABLE} set ${assignments(columns)}, updated_at=? where id=?`, [
      ...columns.map((column) => patch[column] as SQLValue), now(), requiredString(id, "id")
    ]);
  }
  return requirePiGuardianAlert(db, id);
}

export function ackPiGuardianAlert(db: RunnerDatabase, id: string): PiGuardianAlert {
  return updatePiGuardianAlert(db, id, { status: "acked" });
}

export function resolvePiGuardianAlert(
  db: RunnerDatabase,
  id: string,
  input: PiGuardianAlertInput = {}
): PiGuardianAlert {
  return updatePiGuardianAlert(db, id, { ...input, status: "resolved" });
}

export function markPiGuardianAlertRetry(
  db: RunnerDatabase,
  id: string,
  input: PiGuardianAlertRetryInput
): PiGuardianAlert {
  const current = requirePiGuardianAlert(db, id);
  return updatePiGuardianAlert(db, id, {
    direct_feishu_error: cleanString(input.direct_feishu_error),
    direct_feishu_state: "retry",
    max_retry_count: input.max_retry_count,
    next_retry_at: cleanString(input.next_retry_at),
    retry_count: current.retry_count + 1
  });
}

function refreshPiGuardianAlert(
  db: RunnerDatabase,
  id: string,
  record: PiGuardianAlert
): PiGuardianAlert {
  return updatePiGuardianAlert(db, id, {
    evidence_json: record.evidence_json,
    max_retry_count: record.max_retry_count,
    message: record.message,
    severity: record.severity,
    ui_visible: record.ui_visible,
    watchdog_seen_at: record.watchdog_seen_at
  });
}

function normalizeCreate(input: PiGuardianAlertInput): PiGuardianAlert {
  const timestamp = now();
  return {
    alert_type: requiredString(input.alert_type, "alert_type"),
    created_at: timestamp,
    direct_feishu_error: redactAuditText(cleanString(input.direct_feishu_error)),
    direct_feishu_message_id: cleanString(input.direct_feishu_message_id),
    direct_feishu_state: cleanString(input.direct_feishu_state) || "not_attempted",
    evidence_json: redactedJsonPayload(input.evidence_json, "[]"),
    id: cleanString(input.id) || crypto.randomUUID(),
    issue_id: integerInput(input.issue_id),
    max_retry_count: integerInput(input.max_retry_count, 5),
    message: redactAuditText(requiredString(input.message, "message")),
    next_retry_at: cleanString(input.next_retry_at),
    project_id: cleanString(input.project_id),
    retry_count: integerInput(input.retry_count),
    run_group_id: cleanString(input.run_group_id),
    severity: cleanString(input.severity) || "urgent",
    status: alertStatus(input.status, "open"),
    ui_visible: integerInput(input.ui_visible, 1),
    updated_at: timestamp,
    watchdog_seen_at: cleanString(input.watchdog_seen_at) || timestamp
  };
}

function normalizePatch(input: PiGuardianAlertInput): PiGuardianAlertInput {
  const patch = { ...input };
  if (input.evidence_json !== undefined) patch.evidence_json = redactedJsonPayload(input.evidence_json, "[]");
  if (input.message !== undefined) patch.message = redactAuditText(cleanString(input.message));
  if (input.direct_feishu_error !== undefined) {
    patch.direct_feishu_error = redactAuditText(cleanString(input.direct_feishu_error));
  }
  if (input.status !== undefined) patch.status = alertStatus(input.status);
  if (input.ui_visible !== undefined) patch.ui_visible = integerInput(input.ui_visible);
  if (input.retry_count !== undefined) patch.retry_count = integerInput(input.retry_count);
  if (input.max_retry_count !== undefined) patch.max_retry_count = integerInput(input.max_retry_count, 5);
  return patch;
}

function mapAlert(row: Record<string, unknown>): PiGuardianAlert {
  return {
    alert_type: requiredString(row.alert_type, `${TABLE}.alert_type`),
    created_at: requiredString(row.created_at, `${TABLE}.created_at`),
    direct_feishu_error: optionalString(row.direct_feishu_error),
    direct_feishu_message_id: optionalString(row.direct_feishu_message_id),
    direct_feishu_state: optionalString(row.direct_feishu_state),
    evidence_json: redactAuditJsonText(optionalString(row.evidence_json) || "[]"),
    id: requiredString(row.id, `${TABLE}.id`),
    issue_id: integerValue(row.issue_id, `${TABLE}.issue_id`),
    max_retry_count: integerValue(row.max_retry_count, `${TABLE}.max_retry_count`),
    message: redactAuditText(requiredString(row.message, `${TABLE}.message`)),
    next_retry_at: optionalString(row.next_retry_at),
    project_id: optionalString(row.project_id),
    retry_count: integerValue(row.retry_count, `${TABLE}.retry_count`),
    run_group_id: optionalString(row.run_group_id),
    severity: optionalString(row.severity) || "urgent",
    status: alertStatus(row.status),
    ui_visible: integerValue(row.ui_visible, `${TABLE}.ui_visible`),
    updated_at: requiredString(row.updated_at, `${TABLE}.updated_at`),
    watchdog_seen_at: optionalString(row.watchdog_seen_at)
  };
}

function findOpenAlert(db: RunnerDatabase, record: PiGuardianAlert): PiGuardianAlert | null {
  const row = db.sqlite.query<Record<string, unknown>, [string, string, number, string]>(
    `select ${COLUMNS} from ${TABLE}
      where status='open' and alert_type=? and project_id=? and issue_id=? and run_group_id=?
      order by created_at asc, id asc limit 1`
  ).get(record.alert_type, record.project_id, record.issue_id, record.run_group_id);
  return row ? mapAlert(row) : null;
}

function requirePiGuardianAlert(db: RunnerDatabase, id: string): PiGuardianAlert {
  const alert = getPiGuardianAlert(db, id);
  if (!alert) throw new Error(`PI guardian alert ${cleanString(id)} not found`);
  return alert;
}

function alertStatus(value: unknown, fallback?: PiGuardianAlertStatus): PiGuardianAlertStatus {
  const status = cleanString(value) || fallback || "";
  if (STATUSES.has(status as PiGuardianAlertStatus)) return status as PiGuardianAlertStatus;
  throw new Error(`invalid PI guardian alert status ${status}`);
}

function redactedJsonPayload(value: unknown, fallback: string): string {
  if (typeof value === "string") return redactAuditJsonText(jsonText(value, fallback));
  return redactAuditJsonText(JSON.stringify(value ?? JSON.parse(fallback)));
}

function assignments(columns: readonly string[]): string {
  return columns.map((column) => `${column}=?`).join(", ");
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
