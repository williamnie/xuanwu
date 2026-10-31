import type { RunnerDatabase } from "../../database.ts";
import { buildFilter, cleanString, listRows, now, type PatchInput } from "./common.ts";
import { isRunGroupItemReportable } from "../../../pi/reports/runGroupReportStatus.ts";
import { placeholders } from "../../sql.ts";
import {
  normalizeGroupCreate,
  GROUP_TABLE,
  mapGroup,
  normalizeGroupPatch,
  assignments,
  normalizeItemCreate,
  ITEM_TABLE,
  mapItem,
  normalizeItemPatch
} from "./runGroupsModel.ts";

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

type PiRunGroupFilter = { projectId?: string; status?: string };

type SQLValue = string | number;

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

export function refreshPiRunGroupCompletion(db: RunnerDatabase, runGroupID: string): PiRunGroup {
  return db.transaction(() => {
    let group = requirePiRunGroup(db, runGroupID);
    const items = listPiRunGroupItems(db, group.id);
    if (items.length + removedRunGroupIssueIDs(group).length < group.expected_issue_count) {
      // 旧版删除会级联移除成员；只使用同批次、同项目的成功入队回执恢复删除事实。
      const removed = db.sqlite.query<{ issue_id: number }, [string, string]>(`
        select distinct a.issue_id from pi_actions a
        where a.project_id=? and a.action_type='issue.enqueue' and a.status='completed'
          and a.issue_id>0 and json_valid(a.payload_json) and json_valid(a.result_json)
          and json_extract(a.payload_json, '$.run_group_id')=?
          and json_extract(a.payload_json, '$.issue_id')=a.issue_id
          and json_extract(a.result_json, '$.id')=a.issue_id
          and json_extract(a.result_json, '$.project_id')=a.project_id
          and not exists (select 1 from issues i where i.id=a.issue_id)
      `).all(group.project_id, group.id);
      if (removed.length > 0) group = recordRemovedRunGroupIssues(db, group, removed.map((row) => row.issue_id));
    }
    const removed = removedRunGroupIssueIDs(group).filter((id) => !items.some((item) => item.issue_id === id));
    const completed = items.length + removed.length >= group.expected_issue_count && items.every(isRunGroupItemReportable);
    if (!completed || group.status === "completed") return group;
    return updatePiRunGroup(db, group.id, { completed_at: group.completed_at || now(), status: "completed" });
  }).immediate();
}

/** 在删除 Issue 的同一事务内保留成员墓碑，避免把已删除任务继续算作运行中。 */
export function removePiRunGroupIssue(db: RunnerDatabase, issueID: number): void {
  const groups = db.sqlite.query<{ run_group_id: string }, [number]>(
    `select run_group_id from ${ITEM_TABLE} where issue_id=?`
  ).all(issueID);
  for (const { run_group_id: id } of groups) {
    recordRemovedRunGroupIssues(db, requirePiRunGroup(db, id), [issueID]);
    db.sqlite.run(`delete from ${ITEM_TABLE} where run_group_id=? and issue_id=?`, [id, issueID]);
    refreshPiRunGroupCompletion(db, id);
  }
}

export function removedRunGroupIssueIDs(group: PiRunGroup): number[] {
  const ids = groupDigestPolicy(group).removed_issue_ids;
  return Array.isArray(ids) ? [...new Set(ids.filter((id): id is number => Number.isSafeInteger(id) && id > 0))] : [];
}

function recordRemovedRunGroupIssues(db: RunnerDatabase, group: PiRunGroup, ids: number[]): PiRunGroup {
  const removed = [...new Set([...removedRunGroupIssueIDs(group), ...ids])].sort((a, b) => a - b);
  if (JSON.stringify(removed) === JSON.stringify(removedRunGroupIssueIDs(group))) return group;
  return updatePiRunGroup(db, group.id, {
    digest_policy_json: { ...groupDigestPolicy(group), removed_issue_ids: removed }
  });
}

function groupDigestPolicy(group: PiRunGroup): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(group.digest_policy_json);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

export function syncPiRunGroupsForIssueStatus(
  db: RunnerDatabase,
  input: { completedAt?: string; issueID: number; reason?: string; status: string }
): PiRunGroup[] {
  const rows = db.sqlite.query<{ run_group_id: string }, [number]>(
    `select run_group_id from ${ITEM_TABLE} where issue_id=?`
  ).all(input.issueID);
  for (const row of rows) {
    updatePiRunGroupItem(db, row.run_group_id, input.issueID, {
      completed_at: cleanString(input.completedAt),
      final_issue_status: input.status,
      report_reason: cleanString(input.reason)
    });
  }
  return rows.map((row) => refreshPiRunGroupCompletion(db, row.run_group_id));
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
