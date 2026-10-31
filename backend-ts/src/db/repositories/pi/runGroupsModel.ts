import { cleanString, integerInput, integerValue, jsonText, now, optionalString, requiredString } from "./common.ts";
import { deriveRunGroupReportView } from "../../../pi/reports/runGroupReportStatus.ts";
import { type PiRunGroupInput, type PiRunGroup, type PiRunGroupItemInput, type PiRunGroupItem } from "./runGroups.ts";

export const GROUP_TABLE = "pi_run_groups";

export const ITEM_TABLE = "pi_run_group_items";

export function normalizeGroupCreate(input: PiRunGroupInput): PiRunGroup {
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

export function normalizeItemCreate(input: PiRunGroupItemInput): PiRunGroupItem {
  const timestamp = now();
  const enqueue = cleanString(input.enqueue_status) || "pending";
  const report = deriveRunGroupReportView({ ...input, enqueue_status: enqueue });
  return {
    completed_at: reportableTime(input.completed_at, report, timestamp),
    enqueue_action_id: cleanString(input.enqueue_action_id), enqueue_status: enqueue,
    final_issue_status: cleanString(input.final_issue_status), issue_id: integerInput(input.issue_id),
    issue_title_snapshot: cleanString(input.issue_title_snapshot), joined_at: timestamp,
    last_intent_id: cleanString(input.last_intent_id), position: integerInput(input.position),
    report_bucket: report.report_bucket, report_reason: cleanString(input.report_reason),
    report_status: report.report_status, reportable_at: reportableTime(input.reportable_at, report, timestamp),
    run_group_id: requiredString(input.run_group_id, "run_group_id"), status: report.status,
    updated_at: timestamp
  };
}

export function normalizeGroupPatch(input: PiRunGroupInput): PiRunGroupInput {
  return {
    ...input,
    digest_policy_json: input.digest_policy_json === undefined ? undefined : jsonPayload(input.digest_policy_json),
    digest_flush_sequence: input.digest_flush_sequence === undefined ? undefined : integerInput(input.digest_flush_sequence),
    expected_issue_count: input.expected_issue_count === undefined ? undefined : integerInput(input.expected_issue_count),
    max_interval_minutes: input.max_interval_minutes === undefined ? undefined : integerInput(input.max_interval_minutes, 120)
  };
}

export function normalizeItemPatch(input: PiRunGroupItemInput): PiRunGroupItemInput {
  const patch: PiRunGroupItemInput = {
    ...input,
    issue_id: input.issue_id === undefined ? undefined : integerInput(input.issue_id),
    position: input.position === undefined ? undefined : integerInput(input.position)
  };
  if (!hasReportInput(input)) return patch;
  const report = deriveRunGroupReportView(patch);
  return {
    ...patch,
    completed_at: report.reportable ? patch.completed_at ?? now() : "",
    report_bucket: patch.report_bucket ?? report.report_bucket,
    report_status: patch.report_status ?? report.report_status,
    reportable_at: report.reportable ? patch.reportable_at ?? now() : "",
    status: patch.status ?? report.status
  };
}

function hasReportInput(input: PiRunGroupItemInput): boolean {
  return input.enqueue_status !== undefined || input.final_issue_status !== undefined ||
    input.report_bucket !== undefined || input.report_status !== undefined || input.status !== undefined;
}

function reportableTime(value: unknown, report: { reportable: boolean }, timestamp: string): string {
  const explicit = cleanString(value);
  if (explicit !== "") return explicit;
  return report.reportable ? timestamp : "";
}

export function mapGroup(row: Record<string, unknown>): PiRunGroup {
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

export function mapItem(row: Record<string, unknown>): PiRunGroupItem {
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

export function assignments(columns: readonly string[]): string {
  return columns.map((column) => `${column}=?`).join(", ");
}

function jsonPayload(value: unknown): string {
  if (typeof value === "string") return jsonText(value, "{}");
  return JSON.stringify(value ?? {});
}
