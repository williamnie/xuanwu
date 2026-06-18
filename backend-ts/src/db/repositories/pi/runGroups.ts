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

export type PiRunGroup = {
  completed_at: string; created_at: string; deadline_at: string; digest_flush_sequence: number;
  digest_policy_json: string; expected_issue_count: number; id: string; last_digest_at: string;
  max_interval_minutes: number; origin_conversation_id: string; project_id: string;
  source_action_id: string; source_event_id: string; source_event_sequence_id: number;
  source_message_id: string; status: string; updated_at: string; user_phrase: string;
};
export type PiRunGroupItem = {
  completed_at: string; enqueue_action_id: string; enqueue_status: string;
  final_issue_status: string; issue_id: number; issue_title_snapshot: string;
  joined_at: string; last_intent_id: string; position: number; report_bucket: string;
  report_reason: string; report_status: string; reportable_at: string; run_group_id: string;
  status: string; updated_at: string;
};
export type PiRunGroupInput = PatchInput<PiRunGroup>;
export type PiRunGroupItemInput = PatchInput<PiRunGroupItem>;
export type PiRunGroupFilter = { projectId?: string; status?: string };

type SQLValue = string | number;
const GROUP_TABLE = "pi_run_groups";
const ITEM_TABLE = "pi_run_group_items";
const GROUP_COLUMNS = `id, project_id, origin_conversation_id, source_message_id,
  source_action_id, source_event_id, source_event_sequence_id, user_phrase,
  expected_issue_count, status, digest_policy_json, deadline_at, max_interval_minutes,
  last_digest_at, digest_flush_sequence, completed_at, created_at, updated_at`;
const ITEM_COLUMNS = `run_group_id, issue_id, position, issue_title_snapshot,
  enqueue_action_id, enqueue_status, status, final_issue_status, report_status,
  report_bucket, report_reason, last_intent_id, joined_at, reportable_at,
  completed_at, updated_at`;
const GROUP_UPDATES = [
  "status", "digest_policy_json", "deadline_at", "last_digest_at", "digest_flush_sequence", "completed_at",
  "expected_issue_count", "max_interval_minutes", "user_phrase"
] as const;
const ITEM_UPDATES = [
  "position", "issue_title_snapshot", "enqueue_action_id", "enqueue_status", "status",
  "final_issue_status", "report_status", "report_bucket", "report_reason", "last_intent_id",
  "reportable_at", "completed_at"
] as const;

export function createPiRunGroup(db: RunnerDatabase, input: PiRunGroupInput): PiRunGroup {
  const record = normalizeGroupCreate(input);
  const existing = getPiRunGroup(db, record.id);
  if (existing) return existing;
  db.sqlite.run(`insert into ${GROUP_TABLE} (${GROUP_COLUMNS}) values (${placeholders(18)})`, [
    record.id, record.project_id, record.origin_conversation_id, record.source_message_id,
    record.source_action_id, record.source_event_id, record.source_event_sequence_id,
    record.user_phrase, record.expected_issue_count, record.status, record.digest_policy_json,
    record.deadline_at, record.max_interval_minutes, record.last_digest_at,
    record.digest_flush_sequence, record.completed_at, record.created_at, record.updated_at
  ]);
  return requirePiRunGroup(db, record.id);
}

export function getPiRunGroup(db: RunnerDatabase, id: string): PiRunGroup | null {
  const key = cleanString(id);
  if (key === "") return null;
  const row = db.sqlite.query<Record<string, unknown>, [string]>(
    `select ${GROUP_COLUMNS} from ${GROUP_TABLE} where id=?`
  ).get(key);
  return row ? mapGroup(row) : null;
}

export function listPiRunGroups(db: RunnerDatabase, filter: PiRunGroupFilter = {}): PiRunGroup[] {
  return listRows(db, GROUP_TABLE, GROUP_COLUMNS, mapGroup, buildFilter([
    ["project_id=?", filter.projectId],
    ["status=?", filter.status]
  ], "created_at desc, id asc"));
}

export function updatePiRunGroup(db: RunnerDatabase, id: string, input: PiRunGroupInput): PiRunGroup {
  const patch = normalizeGroupPatch(input);
  const columns = GROUP_UPDATES.filter((column) => patch[column] !== undefined);
  if (columns.length > 0) {
    db.sqlite.run(`update ${GROUP_TABLE} set ${assignments(columns)}, updated_at=? where id=?`, [
      ...columns.map((column) => patch[column] as SQLValue), now(), cleanString(id)
    ]);
  }
  return requirePiRunGroup(db, id);
}

export function addPiRunGroupItem(db: RunnerDatabase, input: PiRunGroupItemInput): PiRunGroupItem {
  const record = normalizeItemCreate(input);
  db.sqlite.run(`insert into ${ITEM_TABLE} (${ITEM_COLUMNS}) values (${placeholders(16)})
    on conflict(run_group_id, issue_id) do update set
      position=excluded.position,
      issue_title_snapshot=excluded.issue_title_snapshot,
      enqueue_action_id=excluded.enqueue_action_id,
      enqueue_status=excluded.enqueue_status,
      status=excluded.status,
      final_issue_status=excluded.final_issue_status,
      report_status=excluded.report_status,
      report_bucket=excluded.report_bucket,
      report_reason=excluded.report_reason,
      last_intent_id=excluded.last_intent_id,
      reportable_at=excluded.reportable_at,
      completed_at=excluded.completed_at,
      updated_at=excluded.updated_at`, [
    record.run_group_id, record.issue_id, record.position, record.issue_title_snapshot,
    record.enqueue_action_id, record.enqueue_status, record.status, record.final_issue_status,
    record.report_status, record.report_bucket, record.report_reason, record.last_intent_id,
    record.joined_at, record.reportable_at, record.completed_at, record.updated_at
  ]);
  return requirePiRunGroupItem(db, record.run_group_id, record.issue_id);
}

export function listPiRunGroupItems(db: RunnerDatabase, runGroupID: string): PiRunGroupItem[] {
  return db.sqlite.query<Record<string, unknown>, [string]>(
    `select ${ITEM_COLUMNS} from ${ITEM_TABLE} where run_group_id=? order by position asc, issue_id asc`
  ).all(cleanString(runGroupID)).map(mapItem);
}

export function updatePiRunGroupItem(
  db: RunnerDatabase,
  runGroupID: string,
  issueID: number,
  input: PiRunGroupItemInput
): PiRunGroupItem {
  const patch = normalizeItemPatch(input);
  const columns = ITEM_UPDATES.filter((column) => patch[column] !== undefined);
  if (columns.length > 0) {
    db.sqlite.run(`update ${ITEM_TABLE} set ${assignments(columns)}, updated_at=? where run_group_id=? and issue_id=?`, [
      ...columns.map((column) => patch[column] as SQLValue), now(), cleanString(runGroupID), issueID
    ]);
  }
  return requirePiRunGroupItem(db, runGroupID, issueID);
}

function normalizeGroupCreate(input: PiRunGroupInput): PiRunGroup {
  const timestamp = now();
  return {
    completed_at: cleanString(input.completed_at), created_at: timestamp,
    deadline_at: cleanString(input.deadline_at), digest_flush_sequence: integerInput(input.digest_flush_sequence),
    digest_policy_json: jsonPayload(input.digest_policy_json),
    expected_issue_count: integerInput(input.expected_issue_count), id: cleanString(input.id) || crypto.randomUUID(),
    last_digest_at: cleanString(input.last_digest_at),
    max_interval_minutes: integerInput(input.max_interval_minutes, 120),
    origin_conversation_id: cleanString(input.origin_conversation_id),
    project_id: requiredString(input.project_id, "project_id"), source_action_id: cleanString(input.source_action_id),
    source_event_id: cleanString(input.source_event_id),
    source_event_sequence_id: integerInput(input.source_event_sequence_id),
    source_message_id: cleanString(input.source_message_id), status: cleanString(input.status) || "active",
    updated_at: timestamp, user_phrase: cleanString(input.user_phrase)
  };
}

function normalizeItemCreate(input: PiRunGroupItemInput): PiRunGroupItem {
  const timestamp = now();
  const enqueue = cleanString(input.enqueue_status) || "pending";
  const report = reportFromInput(enqueue, input);
  return {
    completed_at: cleanString(input.completed_at) || report.completedAt,
    enqueue_action_id: cleanString(input.enqueue_action_id), enqueue_status: enqueue,
    final_issue_status: cleanString(input.final_issue_status), issue_id: integerInput(input.issue_id),
    issue_title_snapshot: cleanString(input.issue_title_snapshot), joined_at: timestamp,
    last_intent_id: cleanString(input.last_intent_id), position: integerInput(input.position),
    report_bucket: report.bucket, report_reason: cleanString(input.report_reason),
    report_status: report.status, reportable_at: cleanString(input.reportable_at) || report.reportableAt,
    run_group_id: requiredString(input.run_group_id, "run_group_id"), status: report.itemStatus,
    updated_at: timestamp
  };
}

function normalizeGroupPatch(input: PiRunGroupInput): PiRunGroupInput {
  return {
    ...input,
    digest_policy_json: input.digest_policy_json === undefined ? undefined : jsonPayload(input.digest_policy_json),
    digest_flush_sequence: input.digest_flush_sequence === undefined ? undefined : integerInput(input.digest_flush_sequence),
    expected_issue_count: input.expected_issue_count === undefined ? undefined : integerInput(input.expected_issue_count),
    max_interval_minutes: input.max_interval_minutes === undefined ? undefined : integerInput(input.max_interval_minutes, 120)
  };
}

function normalizeItemPatch(input: PiRunGroupItemInput): PiRunGroupItemInput {
  const patch: PiRunGroupItemInput = {
    ...input,
    issue_id: input.issue_id === undefined ? undefined : integerInput(input.issue_id),
    position: input.position === undefined ? undefined : integerInput(input.position)
  };
  if (input.enqueue_status === undefined) return patch;
  const terminal = terminalForEnqueue(cleanString(input.enqueue_status));
  if (!terminal) return patch;
  return {
    ...patch,
    report_bucket: patch.report_bucket ?? terminal.bucket,
    report_status: patch.report_status ?? terminal.status,
    reportable_at: patch.reportable_at ?? now(),
    status: patch.status ?? terminal.itemStatus
  };
}

function reportFromInput(enqueue: string, input: PiRunGroupItemInput): { bucket: string; completedAt: string; itemStatus: string; reportableAt: string; status: string } {
  const explicitStatus = cleanString(input.status);
  const explicitReport = cleanString(input.report_status);
  const explicitBucket = cleanString(input.report_bucket);
  const terminal = terminalForEnqueue(enqueue);
  if (terminal) return { ...terminal, completedAt: cleanString(input.completed_at), reportableAt: cleanString(input.reportable_at) || now() };
  return {
    bucket: explicitBucket || "active", completedAt: cleanString(input.completed_at),
    itemStatus: explicitStatus || "active", reportableAt: cleanString(input.reportable_at),
    status: explicitReport || "active"
  };
}

function terminalForEnqueue(enqueue: string): { bucket: string; itemStatus: string; status: string } | null {
  if (enqueue === "failed") return { bucket: "skipped", itemStatus: "reportable", status: "enqueue_failed" };
  if (enqueue === "skipped") return { bucket: "skipped", itemStatus: "reportable", status: "skipped" };
  if (enqueue === "pending_approval") return { bucket: "needs_user", itemStatus: "reportable", status: "enqueue_pending_approval" };
  return null;
}

function mapGroup(row: Record<string, unknown>): PiRunGroup {
  return {
    completed_at: optionalString(row.completed_at), created_at: requiredString(row.created_at, `${GROUP_TABLE}.created_at`),
    deadline_at: optionalString(row.deadline_at), digest_flush_sequence: integerValue(row.digest_flush_sequence, "digest_flush_sequence"),
    digest_policy_json: optionalString(row.digest_policy_json) || "{}", expected_issue_count: integerValue(row.expected_issue_count, "expected_issue_count"),
    id: requiredString(row.id, `${GROUP_TABLE}.id`), last_digest_at: optionalString(row.last_digest_at),
    max_interval_minutes: integerValue(row.max_interval_minutes, "max_interval_minutes"),
    origin_conversation_id: optionalString(row.origin_conversation_id), project_id: requiredString(row.project_id, `${GROUP_TABLE}.project_id`),
    source_action_id: optionalString(row.source_action_id), source_event_id: optionalString(row.source_event_id),
    source_event_sequence_id: integerValue(row.source_event_sequence_id, "source_event_sequence_id"),
    source_message_id: optionalString(row.source_message_id), status: requiredString(row.status, `${GROUP_TABLE}.status`),
    updated_at: requiredString(row.updated_at, `${GROUP_TABLE}.updated_at`), user_phrase: optionalString(row.user_phrase)
  };
}

function mapItem(row: Record<string, unknown>): PiRunGroupItem {
  return {
    completed_at: optionalString(row.completed_at), enqueue_action_id: optionalString(row.enqueue_action_id),
    enqueue_status: optionalString(row.enqueue_status) || "pending", final_issue_status: optionalString(row.final_issue_status),
    issue_id: integerValue(row.issue_id, `${ITEM_TABLE}.issue_id`), issue_title_snapshot: optionalString(row.issue_title_snapshot),
    joined_at: requiredString(row.joined_at, `${ITEM_TABLE}.joined_at`), last_intent_id: optionalString(row.last_intent_id),
    position: integerValue(row.position, `${ITEM_TABLE}.position`), report_bucket: optionalString(row.report_bucket) || "active",
    report_reason: optionalString(row.report_reason), report_status: optionalString(row.report_status) || "active",
    reportable_at: optionalString(row.reportable_at), run_group_id: requiredString(row.run_group_id, `${ITEM_TABLE}.run_group_id`),
    status: requiredString(row.status, `${ITEM_TABLE}.status`), updated_at: requiredString(row.updated_at, `${ITEM_TABLE}.updated_at`)
  };
}

function requirePiRunGroup(db: RunnerDatabase, id: string): PiRunGroup {
  const group = getPiRunGroup(db, id);
  if (!group) throw new Error(`PI run group ${cleanString(id)} not found`);
  return group;
}

function requirePiRunGroupItem(db: RunnerDatabase, runGroupID: string, issueID: number): PiRunGroupItem {
  const row = db.sqlite.query<Record<string, unknown>, [string, number]>(
    `select ${ITEM_COLUMNS} from ${ITEM_TABLE} where run_group_id=? and issue_id=?`
  ).get(cleanString(runGroupID), issueID);
  if (!row) throw new Error(`PI run group item ${cleanString(runGroupID)}:${issueID} not found`);
  return mapItem(row);
}

function assignments(columns: readonly string[]): string {
  return columns.map((column) => `${column}=?`).join(", ");
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function jsonPayload(value: unknown): string {
  if (typeof value === "string") return jsonText(value, "{}");
  return JSON.stringify(value ?? {});
}
