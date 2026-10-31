import type { RunnerDatabase } from "../../database.ts";
import { integerValue, jsonText, optionalString, requiredString } from "./common.ts";
import { placeholders } from "../../sql.ts";
import {
  type PiAction,
  COLUMNS,
  TABLE,
  mapPiAction,
  type PiActionEvent,
  EVENT_COLUMNS,
  EVENT_TABLE,
  mapPiActionEvent,
  type RecentAttentionPiActionFilter,
  type PendingPiActionNotification,
  positiveIssueID,
  validJson
} from "./actionsModel.ts";

/** 仅加载活动窗口内的详情，避免单个 Issue 请求反序列化全部历史 payload。 */
export function listPiActivityActions(db: RunnerDatabase, filter: {
  actionIds?: string[]; issueIds?: number[]; conversationId?: string; source?: string;
  since?: string; until?: string; limit?: number;
}): PiAction[] {
  const args: Array<string | number> = [];
  const scope: string[] = [];
  if (filter.actionIds?.length) {
    scope.push(`id in (${placeholders(filter.actionIds.length)})`);
    args.push(...filter.actionIds);
  }
  if (filter.issueIds?.length) {
    scope.push(`issue_id in (${placeholders(filter.issueIds.length)})`);
    args.push(...filter.issueIds);
  }
  if (filter.conversationId) { scope.push("conversation_id=?"); args.push(filter.conversationId); }
  const where = scope.length ? [`(${scope.join(" or ")})`] : [];
  if (filter.source) { where.push("source=?"); args.push(filter.source); }
  if (filter.since && Number.isFinite(Date.parse(filter.since))) { where.push("julianday(updated_at)>=julianday(?)"); args.push(filter.since); }
  if (filter.until && Number.isFinite(Date.parse(filter.until))) { where.push("julianday(updated_at)<=julianday(?)"); args.push(filter.until); }
  const limit = Number.isSafeInteger(filter.limit) && Number(filter.limit) > 0 ? Math.min(500, Number(filter.limit)) : 500;
  return db.sqlite.query<Record<string, unknown>, Array<string | number>>(`
    select ${COLUMNS} from ${TABLE}
    ${where.length ? `where ${where.join(" and ")}` : ""}
    order by updated_at desc, id desc limit ?
  `).all(...args, limit).map(mapPiAction);
}

export function latestCompletedEnqueueAction(db: RunnerDatabase, issueID: number): Pick<PiAction, "id" | "source"> | null {
  return db.sqlite.query<Pick<PiAction, "id" | "source">, [number]>(`
    select id, source from pi_actions
    where issue_id=? and action_type='issue.enqueue' and status='completed'
    order by created_at desc, id desc limit 1
  `).get(issueID);
}

/** 一次读取最新的关联审计，避免逐 Action/Issue 扫描并重复加载历史。 */
export function listPiActivityActionEvents(db: RunnerDatabase, scope: {
  actionIds?: string[]; issueIds?: number[]; conversationId?: string;
  since?: string; until?: string;
}): PiActionEvent[] {
  const args: Array<string | number> = [];
  const where: string[] = [];
  if (scope.actionIds?.length) { where.push(`action_id in (${placeholders(scope.actionIds.length)})`); args.push(...scope.actionIds); }
  if (scope.issueIds?.length) { where.push(`issue_id in (${placeholders(scope.issueIds.length)})`); args.push(...scope.issueIds); }
  if (scope.conversationId) { where.push("conversation_id=?"); args.push(scope.conversationId); }
  if (where.length === 0) return [];
  const conditions = [`(${where.join(" or ")})`];
  if (scope.since && Number.isFinite(Date.parse(scope.since))) { conditions.push("julianday(created_at)>=julianday(?)"); args.push(scope.since); }
  if (scope.until && Number.isFinite(Date.parse(scope.until))) { conditions.push("julianday(created_at)<=julianday(?)"); args.push(scope.until); }
  return db.sqlite.query<Record<string, unknown>, Array<string | number>>(`
    select ${EVENT_COLUMNS} from ${EVENT_TABLE} where ${conditions.join(" and ")}
    order by id desc limit 500
  `).all(...args).map(mapPiActionEvent);
}

export function listRecentAttentionPiActions(
  db: RunnerDatabase,
  filter: RecentAttentionPiActionFilter
): PiAction[] {
  const limit = Math.min(Math.max(Math.trunc(filter.limit), 1), 25);
  const updatedAfter = requiredString(filter.updatedAfter, "pi_actions.updated_after");
  return db.sqlite.query<Record<string, unknown>, [string, number]>(`
    select ${COLUMNS} from ${TABLE} indexed by idx_pi_actions_attention_recent
    where status in ('candidate', 'pending', 'approved', 'changes_requested', 'snoozed')
      and updated_at>=?
    order by updated_at desc, id desc
    limit ?
  `).all(updatedAfter, limit).map(mapPiAction);
}

export function listActiveAttentionPiActions(db: RunnerDatabase): PiAction[] {
  return db.sqlite.query<Record<string, unknown>, []>(`
    select ${COLUMNS} from ${TABLE} indexed by idx_pi_actions_attention_recent
    where status in ('candidate', 'pending', 'approved', 'changes_requested', 'snoozed')
    order by updated_at desc, id desc
  `).all().map(mapPiAction);
}

export function listPendingPiActionNotifications(
  db: RunnerDatabase,
  createdAfter: string
): PendingPiActionNotification[] {
  return db.sqlite.query<Record<string, unknown>, [string]>(`
    select id, project_id, issue_id, conversation_id, action_type, status,
      payload_json, created_at
    from ${TABLE} indexed by idx_pi_actions_pending_notification
    where status='pending'
      and action_type in ('assistant.tool.call', 'mcp.tool.call')
      and created_at>=?
    order by created_at asc, id asc
  `).all(createdAfter).map((row) => ({
    action_type: requiredString(row.action_type, `${TABLE}.action_type`),
    conversation_id: optionalString(row.conversation_id),
    created_at: requiredString(row.created_at, `${TABLE}.created_at`),
    id: requiredString(row.id, `${TABLE}.id`),
    issue_id: integerValue(row.issue_id, `${TABLE}.issue_id`),
    payload_json: jsonText(row.payload_json, "{}"),
    project_id: optionalString(row.project_id),
    status: requiredString(row.status, `${TABLE}.status`)
  }));
}

/**
 * Returns only Actions whose normalized carrier payload references one Issue.
 *
 * Work detail must not materialize every historical Action (and every large
 * payload/result JSON value) just to project relations for a single Work.
 */
export function listPiActionsReferencingIssue(db: RunnerDatabase, issueID: number): PiAction[] {
  const id = positiveIssueID(issueID);
  const payload = validJson("payload_json");
  const result = validJson("result_json");
  const args = Array.from({ length: 7 }, () => id);
  return db.sqlite.query<Record<string, unknown>, number[]>(`
    select ${COLUMNS} from ${TABLE}
    where issue_id=?
      or cast(json_extract(${payload}, '$.issue_id') as integer)=?
      or cast(json_extract(${payload}, '$.target_issue_id') as integer)=?
      or exists (
        select 1 from json_each(${payload}, '$.issue_ids')
        where cast(json_each.value as integer)=?
      )
      or exists (
        select 1 from json_each(${payload}, '$.target_issue_ids')
        where cast(json_each.value as integer)=?
      )
      or (
        action_type in ('issue.create', 'agent.workflow_request')
        and (
          cast(json_extract(${result}, '$.id') as integer)=?
          or cast(json_extract(${result}, '$.issue_id') as integer)=?
        )
      )
    order by created_at asc, id asc
  `).all(...args).map(mapPiAction);
}
