import type { RunnerDatabase } from "../db/database.ts";
import {
  ackPiGuardianAlert,
  getPiGuardianAlert,
  listPiGuardianAlerts,
  type PiGuardianAlert,
  type PiGuardianAlertFilter
} from "../db/repositories/pi.ts";
import { redactAuditText } from "../db/repositories/pi/auditRedaction.ts";
import { HttpError, json } from "./errors.ts";
import type { Router } from "./router.ts";

type PiGuardianAlertsContext = { database: RunnerDatabase };

export function registerPiGuardianAlertRoutes(router: Router, context: PiGuardianAlertsContext): void {
  router.get("/api/pi/guardian/alerts", (request) => json(alertsResponse(context.database, request)));
  router.post("/api/pi/guardian/alerts/:id/ack", (request) => json(ackAlertResponse(context.database, request)));
}

function alertsResponse(db: RunnerDatabase, request: Request): Array<Record<string, unknown>> {
  return listPiGuardianAlerts(db, alertFilter(request)).map(alertResponse);
}

function ackAlertResponse(db: RunnerDatabase, request: Request): Record<string, unknown> {
  const alert = requireAlert(db, alertID(request));
  if (alert.status !== "open") return alertResponse(alert);
  return alertResponse(ackPiGuardianAlert(db, alert.id));
}

function alertFilter(request: Request): PiGuardianAlertFilter {
  const params = new URL(request.url).searchParams;
  const status = clean(params.get("status"));
  return {
    alertType: clean(params.get("alert_type") ?? params.get("alertType")),
    projectId: clean(params.get("project_id") ?? params.get("projectId")),
    status: status === "all" ? undefined : status || "open"
  };
}

function alertResponse(alert: PiGuardianAlert): Record<string, unknown> {
  return {
    alert_type: alert.alert_type,
    created_at: alert.created_at,
    direct_feishu_error: safeText(alert.direct_feishu_error),
    direct_feishu_message_id: safeText(alert.direct_feishu_message_id),
    direct_feishu_state: alert.direct_feishu_state,
    evidence: safeJson(alert.evidence_json),
    id: alert.id,
    issue_id: alert.issue_id,
    max_retry_count: alert.max_retry_count,
    message: safeText(alert.message),
    next_retry_at: alert.next_retry_at,
    project_id: alert.project_id,
    retry_count: alert.retry_count,
    run_group_id: alert.run_group_id,
    severity: alert.severity,
    status: alert.status,
    ui_visible: alert.ui_visible,
    updated_at: alert.updated_at,
    watchdog_seen_at: alert.watchdog_seen_at
  };
}

function requireAlert(db: RunnerDatabase, id: string): PiGuardianAlert {
  const alert = getPiGuardianAlert(db, id);
  if (!alert) throw new HttpError(404, "资源不存在");
  return alert;
}

function alertID(request: Request): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const value = parts[parts.indexOf("alerts") + 1]?.trim() ?? "";
  if (value === "") throw new HttpError(400, "guardian alert id 不能为空");
  return decodeURIComponent(value);
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value || "[]") as unknown;
  } catch {
    return safeText(value);
  }
}

function safeText(value: string): string {
  return redactAuditText(value);
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
