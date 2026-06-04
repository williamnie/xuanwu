import type { RunnerDatabase } from "../db/database.ts";
import { getPiReportRecord, listPiReportRecords } from "../db/repositories/pi.ts";
import type { EventBus } from "../events/bus.ts";
import { buildPiReport } from "../pi/reports.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

type PiReportsContext = { bus?: EventBus; codexSessionsDir?: string; database: RunnerDatabase };

export function registerPiReportRoutes(router: Router, context: PiReportsContext): void {
  router.get("/api/pi/reports", (request) => json(listReports(context, request)));
  router.get("/api/pi/reports/:id", (request) => json(reportDetail(context, request)));
  router.post("/api/pi/reports/generate", async (request) => json(await generateReport(context, request), { status: 201 }));
}

function listReports(context: PiReportsContext, request: Request): unknown {
  const params = new URL(request.url).searchParams;
  return listPiReportRecords(context.database, {
    delegationId: cleanString(params.get("delegation_id")),
    heartbeatId: cleanString(params.get("heartbeat_id")),
    projectId: cleanString(params.get("project_id")),
    source: cleanString(params.get("source")),
    status: cleanString(params.get("status")),
    type: cleanString(params.get("type"))
  }).map((record) => ({
    delegation_id: record.delegation_id,
    generated_at: record.generated_at,
    heartbeat_id: record.heartbeat_id,
    id: record.id,
    issue_ids: parseJsonArray(record.issue_ids_json),
    project_id: record.project_id,
    source: record.source,
    status: record.status,
    summary: parseJsonObject(record.summary_json),
    type: record.type,
    window: { since: record.since_at, until: record.until_at }
  }));
}

function reportDetail(context: PiReportsContext, request: Request): unknown {
  const report = getPiReportRecord(context.database, numericID(request));
  if (!report) throw new HttpError(404, "资源不存在");
  return { ...parseJsonObject(report.body_json), report_id: report.id };
}

async function generateReport(context: PiReportsContext, request: Request): Promise<unknown> {
  const body = await objectBody(request);
  return buildPiReport({
    bus: context.bus,
    codexSessionsDir: context.codexSessionsDir,
    database: context.database,
    delegationID: cleanString(body.delegation_id),
    heartbeatID: cleanString(body.heartbeat_id),
    projectID: cleanString(body.project_id),
    since: cleanString(body.since),
    source: cleanString(body.source),
    type: cleanString(body.type) || "manual",
    until: cleanString(body.until)
  });
}

async function objectBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await parseJsonBody(request);
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch (error) {
    if (error instanceof HttpError) throw new HttpError(400, "请求体不是合法 JSON");
    throw error;
  }
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numericID(request: Request): number {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const id = Number(parts[parts.indexOf("reports") + 1] ?? 0);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "report id 不合法");
  return id;
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
