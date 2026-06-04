import type { RunnerDatabase } from "../../database.ts";
import { integerInput, integerValue, optionalString } from "./common.ts";
import { redactAuditJsonText, redactAuditText } from "./auditRedaction.ts";

export type PiHeartbeatTimelineFilter = { issueId?: number; limit?: number; projectId?: string };
export type PiHeartbeatTimelineStage = "signal" | "decision" | "action" | "result";
export type PiHeartbeatTimelineSource = "action" | "heartbeat";
export type PiHeartbeatTimelineItem = {
  id: string; row_id: number; source: PiHeartbeatTimelineSource; stage: PiHeartbeatTimelineStage;
  event_type: string; created_at: string; project_id: string; issue_id: number;
  heartbeat_id: string; action_id: string; delegation_id: string; actor: string;
  decision: string; message: string; payload_json: string; result_json: string; error: string;
};

type SqlValue = string | number;
type TimelineRow = Record<string, unknown>;

const DEFAULT_LIMIT = 80;
const MAX_LIMIT = 200;

export function listPiHeartbeatTimeline(
  db: RunnerDatabase,
  filter: PiHeartbeatTimelineFilter = {}
): PiHeartbeatTimelineItem[] {
  const limit = normalizeLimit(filter.limit);
  return [
    ...listHeartbeatTimelineRows(db, filter, limit),
    ...listActionTimelineRows(db, filter, limit)
  ].sort(compareTimelineItems).slice(0, limit);
}

function listHeartbeatTimelineRows(
  db: RunnerDatabase,
  filter: PiHeartbeatTimelineFilter,
  limit: number
): PiHeartbeatTimelineItem[] {
  const where = heartbeatWhere(filter);
  return db.sqlite.query<TimelineRow, SqlValue[]>(`
    select id, heartbeat_id, project_id, delegation_id, event_type,
      message, payload_json, error, created_at
    from pi_heartbeat_events${where.sql}
    order by created_at desc, id desc limit ?
  `).all(...where.args, limit).map(mapHeartbeatTimelineItem);
}

function listActionTimelineRows(
  db: RunnerDatabase,
  filter: PiHeartbeatTimelineFilter,
  limit: number
): PiHeartbeatTimelineItem[] {
  const where = actionWhere(filter);
  return db.sqlite.query<TimelineRow, SqlValue[]>(`
    select id, action_id, project_id, issue_id, conversation_id, event_type,
      actor, decision, reason, payload_json, result_json, error,
      delegation_id, heartbeat_id, created_at
    from pi_action_events${where.sql}
    order by created_at desc, id desc limit ?
  `).all(...where.args, limit).map(mapActionTimelineItem);
}

function heartbeatWhere(filter: PiHeartbeatTimelineFilter): { args: SqlValue[]; sql: string } {
  const args: SqlValue[] = [];
  const conditions: string[] = [];
  const projectId = clean(filter.projectId);
  const issueId = integerInput(filter.issueId);
  if (projectId !== "") {
    conditions.push("project_id=?");
    args.push(projectId);
  }
  if (issueId > 0) {
    conditions.push(`heartbeat_id in (
      select heartbeat_id from pi_action_events where issue_id=? and heartbeat_id<>''
      union select heartbeat_id from pi_actions where issue_id=? and heartbeat_id<>''
    )`);
    args.push(issueId, issueId);
  }
  return whereClause(conditions, args);
}

function actionWhere(filter: PiHeartbeatTimelineFilter): { args: SqlValue[]; sql: string } {
  const args: SqlValue[] = [];
  const conditions: string[] = [];
  const projectId = clean(filter.projectId);
  const issueId = integerInput(filter.issueId);
  if (projectId !== "") {
    conditions.push("project_id=?");
    args.push(projectId);
  }
  if (issueId > 0) {
    conditions.push("issue_id=?");
    args.push(issueId);
  }
  return whereClause(conditions, args);
}

function mapHeartbeatTimelineItem(row: TimelineRow): PiHeartbeatTimelineItem {
  const eventType = optionalString(row.event_type);
  const payloadJson = redactAuditJsonText(optionalString(row.payload_json) || "{}");
  const error = redactAuditText(optionalString(row.error));
  return {
    action_id: "",
    actor: "heartbeat",
    created_at: optionalString(row.created_at),
    decision: "",
    delegation_id: optionalString(row.delegation_id),
    error,
    event_type: eventType,
    heartbeat_id: optionalString(row.heartbeat_id),
    id: `heartbeat:${integerValue(row.id, "pi_heartbeat_events.id")}`,
    issue_id: 0,
    message: heartbeatMessage(row, payloadJson, error),
    payload_json: payloadJson,
    project_id: optionalString(row.project_id),
    result_json: "{}",
    row_id: integerValue(row.id, "pi_heartbeat_events.id"),
    source: "heartbeat",
    stage: heartbeatStage(eventType)
  };
}

function mapActionTimelineItem(row: TimelineRow): PiHeartbeatTimelineItem {
  const eventType = optionalString(row.event_type);
  const payloadJson = redactAuditJsonText(optionalString(row.payload_json) || "{}");
  const resultJson = redactAuditJsonText(optionalString(row.result_json) || "{}");
  const error = redactAuditText(optionalString(row.error));
  return {
    action_id: optionalString(row.action_id),
    actor: optionalString(row.actor),
    created_at: optionalString(row.created_at),
    decision: optionalString(row.decision),
    delegation_id: optionalString(row.delegation_id),
    error,
    event_type: eventType,
    heartbeat_id: optionalString(row.heartbeat_id),
    id: `action:${integerValue(row.id, "pi_action_events.id")}`,
    issue_id: integerValue(row.issue_id, "pi_action_events.issue_id"),
    message: actionMessage(row, payloadJson, resultJson, error),
    payload_json: payloadJson,
    project_id: optionalString(row.project_id),
    result_json: resultJson,
    row_id: integerValue(row.id, "pi_action_events.id"),
    source: "action",
    stage: actionStage(eventType)
  };
}

function heartbeatMessage(row: TimelineRow, payloadJson: string, error: string): string {
  const message = redactAuditText(optionalString(row.message));
  if (message !== "") return message;
  if (error !== "") return error;
  const payload = jsonObject(payloadJson);
  if (typeof payload.count === "number") return `count=${payload.count}`;
  if (typeof payload.next_tick_at === "string") return `next tick ${payload.next_tick_at}`;
  return "";
}

function actionMessage(row: TimelineRow, payloadJson: string, resultJson: string, error: string): string {
  const reason = redactAuditText(optionalString(row.reason));
  if (reason !== "") return reason;
  if (error !== "") return error;
  const result = jsonObject(resultJson);
  if (typeof result.action_type === "string") return `${result.action_type} ${result.status ?? ""}`.trim();
  const payload = jsonObject(payloadJson);
  return typeof payload.action_type === "string" ? payload.action_type : "";
}

function heartbeatStage(eventType: string): PiHeartbeatTimelineStage {
  if (eventType === "collect_signals") return "signal";
  if (eventType === "evaluate_policies" || eventType === "authorization_gate") return "decision";
  if (eventType === "plan_actions" || eventType === "action_proposed") return "action";
  return "result";
}

function actionStage(eventType: string): PiHeartbeatTimelineStage {
  if (eventType === "candidate") return "signal";
  if (eventType.includes("decision") || eventType === "pending_approval") return "decision";
  if (eventType === "execution_started") return "action";
  return "result";
}

function compareTimelineItems(a: PiHeartbeatTimelineItem, b: PiHeartbeatTimelineItem): number {
  const timeDelta = Date.parse(b.created_at || "") - Date.parse(a.created_at || "");
  if (Number.isFinite(timeDelta) && timeDelta !== 0) return timeDelta;
  return b.row_id - a.row_id;
}

function normalizeLimit(value: unknown): number {
  const limit = integerInput(value, DEFAULT_LIMIT);
  if (limit <= 0) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

function whereClause(conditions: string[], args: SqlValue[]): { args: SqlValue[]; sql: string } {
  return { args, sql: conditions.length > 0 ? ` where ${conditions.join(" and ")}` : "" };
}

function jsonObject(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text || "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
