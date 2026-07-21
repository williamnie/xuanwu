import type { RunnerDatabase } from "../db/database.ts";
import {
  createPiReportRecord,
  getPiNotificationPreference,
  listPiGuardianAlerts,
  listPiReportRecords,
  readProjectPiPolicy
} from "../db/repositories/pi.ts";
import type { PiGuardianAlert } from "../db/repositories/pi/guardianAlerts.ts";
import { routeNotification, type NotificationRoute } from "../notifications/unifiedNotificationPipeline.ts";
import { guardianAlertPresentation } from "./guardianAlertPresentation.ts";

export type GuardianOperationsSummary = {
  active_pi_handling: number;
  active_user_action_required: number;
  alerts_detected: number;
  alerts_recovered: number;
  issue_retries_recovered: number;
  session_recoveries: number;
};

export type GuardianOperationsSnapshot = {
  generated_at: string;
  incidents: Array<Record<string, unknown>>;
  project_id: string;
  summary: GuardianOperationsSummary;
  window: { since: string; until: string };
};

export type GuardianOperationsDailyReportResult = {
  generated: number;
  queued: number;
  scanned: number;
  skipped: number;
};

type RouteRow = {
  preference_id: string;
  project_id: string;
  target_channel: string;
  target_chat_id: string;
  target_message_id: string;
  target_thread_id: string;
  updated_at: string;
};

const DEFAULT_DAILY_AT = "09:00";
const REPORT_TYPE = "daily_operations_digest";
const REPORT_SOURCE = "pi_guardian_scheduler";

export function guardianOperationsSnapshot(
  db: RunnerDatabase,
  input: { now?: Date; projectID?: string; since?: string; until?: string } = {}
): GuardianOperationsSnapshot {
  const now = input.now ?? new Date();
  const until = validTimestamp(input.until) || now.toISOString();
  const since = validTimestamp(input.since) || new Date(Date.parse(until) - 24 * 60 * 60_000).toISOString();
  const projectID = clean(input.projectID);
  const alerts = listPiGuardianAlerts(db).filter((alert) => scopeMatches(alert, projectID, input.projectID === undefined));
  // Acknowledged incidents remain in the source until recovery, but the user
  // explicitly asked not to be reminded again. Keep them out of current action
  // counts while recovery maintenance continues to reconcile them.
  const active = alerts.filter((alert) => alert.status === "open");
  const presentations = active.map((alert) => ({ alert, presentation: guardianAlertPresentation(alert, new Date(until)) }));
  const detected = alerts.filter((alert) => inWindow(alert.created_at, since, until));
  const recovered = alerts.filter((alert) => alert.status === "resolved" && inWindow(alert.updated_at, since, until));
  const recoveryCounts = recoveryCountsInWindow(db, projectID, since, until);
  return {
    generated_at: now.toISOString(),
    incidents: incidentRows([...recovered, ...detected], new Date(until)),
    project_id: projectID,
    summary: {
      active_pi_handling: presentations.filter((item) => item.presentation.handling === "pi_handling").length,
      active_user_action_required: presentations.filter((item) => item.presentation.requires_user).length,
      alerts_detected: detected.length,
      alerts_recovered: recovered.length,
      issue_retries_recovered: recoveryCounts.issueRetries,
      session_recoveries: recoveryCounts.sessions
    },
    window: { since, until }
  };
}

export function queueGuardianOperationsDailyReports(
  db: RunnerDatabase,
  input: { now?: Date } = {}
): GuardianOperationsDailyReportResult {
  const now = input.now ?? new Date();
  const routes = latestProjectRoutes(db);
  const result: GuardianOperationsDailyReportResult = {
    generated: 0,
    queued: 0,
    scanned: routes.length,
    skipped: 0
  };
  for (const target of routes) {
    const policy = readProjectPiPolicy(db, target.row.project_id);
    const dailyAt = reportTime(db, target.row.preference_id);
    const stamp = localStamp(now, policy.timezone);
    if (stamp.time < dailyAt || reportExists(db, target.row.project_id, stamp.date)) {
      result.skipped += 1;
      continue;
    }
    const snapshot = guardianOperationsSnapshot(db, {
      now,
      projectID: target.row.project_id,
      since: new Date(now.getTime() - 24 * 60 * 60_000).toISOString(),
      until: now.toISOString()
    });
    const reportKey = `pi-operations-daily:${target.row.project_id || "global"}:${stamp.date}`;
    const routed = routeNotification(db, {
      content: formatGuardianOperationsDailyReport(snapshot, stamp.date),
      decision: "send_now",
      deepLink: "#/command-center",
      idempotencyKey: reportKey,
      kind: REPORT_TYPE,
      notificationType: "pi_operations_daily_digest",
      now,
      payload: { bucket: stamp.date, ...snapshot },
      projectID: target.row.project_id,
      routes: [target.route],
      severity: "info",
      sourceEventID: reportKey,
      sourceEventType: "pi.operations.daily_digest",
      summary: `PI 运维日报 ${stamp.date}`
    })[0];
    if (!routed) {
      result.skipped += 1;
      continue;
    }
    createPiReportRecord(db, {
      body_json: JSON.stringify({ bucket: stamp.date, notification_intent_id: routed.intent.id, ...snapshot }),
      project_id: target.row.project_id,
      since_at: snapshot.window.since,
      source: REPORT_SOURCE,
      status: "generated",
      summary_json: JSON.stringify(snapshot.summary),
      type: REPORT_TYPE,
      until_at: snapshot.window.until
    });
    result.generated += 1;
    if (routed.queued || routed.intent.state === "sent" || routed.intent.state === "agent_pending") result.queued += 1;
  }
  return result;
}

export function latestGuardianOperationsReport(
  db: RunnerDatabase,
  projectID = ""
): Record<string, unknown> | null {
  const record = listPiReportRecords(db, projectID ? { projectId: projectID, type: REPORT_TYPE } : { type: REPORT_TYPE })[0];
  if (!record) return null;
  return {
    generated_at: record.generated_at,
    id: record.id,
    project_id: record.project_id,
    summary: parseRecord(record.summary_json),
    type: record.type,
    window: { since: record.since_at, until: record.until_at }
  };
}

export function formatGuardianOperationsDailyReport(snapshot: GuardianOperationsSnapshot, bucket: string): string {
  const value = snapshot.summary;
  const scope = snapshot.project_id ? `项目 ${snapshot.project_id}` : "Runner 系统";
  const lines = [
    `PI 运维日报 · ${bucket} · ${scope}`,
    `过去 24 小时发现 ${value.alerts_detected} 个运行告警，已自动恢复 ${value.alerts_recovered} 个。`,
    `恢复会话 ${value.session_recoveries} 个，自动重试并恢复 Issue ${value.issue_retries_recovered} 个。`,
    value.active_user_action_required > 0
      ? `仍有 ${value.active_user_action_required} 项需要你处理，已集中放入 Command Center。`
      : `当前没有需要你介入的运行告警。`,
    value.active_pi_handling > 0 ? `PI 正在继续处理 ${value.active_pi_handling} 项，其余过程不会逐条打扰你。` : "PI 当前没有待处理的运行告警。"
  ];
  return lines.join("\n");
}

function latestProjectRoutes(db: RunnerDatabase): Array<{ route: NotificationRoute; row: RouteRow }> {
  const rows = db.sqlite.query<RouteRow, []>(`
    select project_id, preference_id, target_channel, target_chat_id,
      target_thread_id, target_message_id, updated_at
    from pi_notification_intents
    where target_channel<>'' and (target_chat_id<>'' or target_thread_id<>'' or target_message_id<>'')
    order by updated_at desc, created_at desc, id desc limit 500
  `).all();
  const selected = new Map<string, RouteRow>();
  for (const row of rows) if (!selected.has(row.project_id)) selected.set(row.project_id, row);
  return [...selected.values()].map((row) => ({
    route: {
      channel: row.target_channel,
      chatID: row.target_chat_id,
      messageID: row.target_message_id,
      threadID: row.target_thread_id
    },
    row
  }));
}

function reportTime(db: RunnerDatabase, preferenceID: string): string {
  const preference = getPiNotificationPreference(db, preferenceID);
  const dailyAt = clean(parseRecord(preference?.digest_policy_json ?? "{}").daily_at);
  return /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(dailyAt) ? dailyAt : DEFAULT_DAILY_AT;
}

function reportExists(db: RunnerDatabase, projectID: string, bucket: string): boolean {
  return listPiReportRecords(db, { projectId: projectID, type: REPORT_TYPE }).some((record) => {
    return clean(parseRecord(record.body_json).bucket) === bucket;
  });
}

function recoveryCountsInWindow(
  db: RunnerDatabase,
  projectID: string,
  since: string,
  until: string
): { issueRetries: number; sessions: number } {
  const projectClause = projectID ? "and project_id=?" : "";
  const args = projectID ? [since, until, projectID] : [since, until];
  const rows = db.sqlite.query<{ action_type: string; count: number }, string[]>(`
    select action_type, count(*) as count from pi_recovery_attempts
    where status='progress' and updated_at>=? and updated_at<=? ${projectClause}
      and action_type in ('session.resume_followup','session.steer','issue.retry')
    group by action_type
  `).all(...args);
  return {
    issueRetries: rows.filter((row) => row.action_type === "issue.retry").reduce((total, row) => total + row.count, 0),
    sessions: rows.filter((row) => row.action_type !== "issue.retry").reduce((total, row) => total + row.count, 0)
  };
}

function incidentRows(alerts: PiGuardianAlert[], now: Date): Array<Record<string, unknown>> {
  const unique = new Map(alerts.map((alert) => [alert.id, alert]));
  return [...unique.values()].sort((left, right) => right.updated_at.localeCompare(left.updated_at)).slice(0, 10)
    .map((alert) => ({
      alert_id: alert.id,
      alert_type: alert.alert_type,
      project_id: alert.project_id,
      status: alert.status,
      ...guardianAlertPresentation(alert, now)
    }));
}

function scopeMatches(alert: PiGuardianAlert, projectID: string, allProjects: boolean): boolean {
  if (allProjects) return true;
  return projectID === "" ? alert.project_id === "" : alert.project_id === "" || alert.project_id === projectID;
}

function inWindow(value: string, since: string, until: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= Date.parse(since) && time <= Date.parse(until);
}

function localStamp(date: Date, timezone: string): { date: string; time: string } {
  let parts: Record<string, string>;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      day: "2-digit", hour: "2-digit", hourCycle: "h23", minute: "2-digit",
      month: "2-digit", timeZone: timezone || "UTC", year: "numeric"
    }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  } catch {
    return localStamp(date, "UTC");
  }
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(typeof value === "string" ? value : "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function validTimestamp(value: unknown): string {
  const text = clean(value);
  return Number.isFinite(Date.parse(text)) ? text : "";
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
