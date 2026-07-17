import type { RunnerDatabase } from "../db/database.ts";
import { getIssue } from "../db/repositories/issues.ts";
import {
  recordTrackerSyncAudit,
  trackerIssueProvider,
  upsertTrackerIssueLink,
  upsertTrackerProjectMapping
} from "../db/repositories/trackerIssueSync.ts";
import { syncTrackerIssueEvent, trackerIssueFromPayload } from "../integrations/tracker/issueSync.ts";
import { HttpError, json } from "./errors.ts";
import type { Router } from "./router.ts";

type Context = { database: RunnerDatabase };
type JsonObject = Record<string, unknown>;

export function registerTrackerEventRoutes(router: Router, context: Context): void {
  router.put("/api/integrations/trackers/mappings", (request) => mappingResponse(context, request));
  router.put("/api/integrations/trackers/:provider/links", (request) => manualLinkResponse(context, request));
  router.post("/api/integrations/trackers/:provider/events", (request) => eventResponse(context, request));
  router.post("/api/integrations/trackers/:provider/poll", (request) => pollResponse(context, request));
}

async function mappingResponse(context: Context, request: Request): Promise<Response> {
  const body = await objectBody(request);
  try {
    const mapping = upsertTrackerProjectMapping(context.database, {
      project_id: text(body.project_id), provider: trackerIssueProvider(body.provider), scope: text(body.scope)
    });
    recordTrackerSyncAudit(context.database, {
      action: "mapping_upserted", correlation_id: auditID(body), external_id: text(body.scope), project_id: mapping.project_id,
      provider: mapping.provider, detail: { actor: text(object(body.audit, "audit").actor), reason: text(object(body.audit, "audit").reason) }
    });
    return json({ mapping }, { status: 201 });
  } catch (error) { throw invalid(error); }
}

async function manualLinkResponse(context: Context, request: Request): Promise<Response> {
  const body = await objectBody(request);
  try {
    const provider = providerFromPath(request);
    const issueID = positiveInteger(body.issue_id);
    const issue = getIssue(context.database, issueID);
    if (!issue) throw new Error("issue not found");
    const externalID = text(body.external_id);
    const link = upsertTrackerIssueLink(context.database, {
      external_id: externalID, issue_id: issueID, last_synced_issue_updated_at: issue.updated_at, provider
    });
    recordTrackerSyncAudit(context.database, {
      action: "manual_linked", correlation_id: auditID(body), external_id: externalID, issue_id: issueID, project_id: issue.project_id,
      provider, detail: { actor: text(object(body.audit, "audit").actor), reason: text(object(body.audit, "audit").reason) }
    });
    return json({ link }, { status: 201 });
  } catch (error) { throw invalid(error); }
}

async function eventResponse(context: Context, request: Request): Promise<Response> {
  const payload = await objectBody(request);
  try {
    const provider = providerFromPath(request);
    const result = syncTrackerIssueEvent(context.database, trackerIssueFromPayload(
      provider, payload, request.headers.get("x-github-event") ?? request.headers.get("x-gitlab-event") ?? request.headers.get("x-linear-event") ?? "issue",
      request.headers.get("x-tracker-delivery") ?? request.headers.get("x-github-delivery") ?? request.headers.get("x-gitlab-event-uuid") ?? request.headers.get("x-linear-delivery") ?? undefined
    ));
    return json({ accepted: true, ...result }, { status: result.replayed ? 200 : 202 });
  } catch (error) { throw invalid(error); }
}

async function pollResponse(context: Context, request: Request): Promise<Response> {
  const body = await objectBody(request);
  const events = Array.isArray(body.events) ? body.events : [];
  if (events.length === 0 || events.length > 100) throw new HttpError(400, "events must contain 1 to 100 tracker events");
  try {
    const provider = providerFromPath(request);
    const results = events.map((value) => {
      const event = object(value, "event");
      return syncTrackerIssueEvent(context.database, trackerIssueFromPayload(provider, object(event.payload, "event.payload"), text(event.event_name, "issue"), optionalText(event.cursor)), "poll");
    });
    return json({ accepted: true, provider, results, summary: { conflicts: results.filter((item) => item.conflict).length, replayed: results.filter((item) => item.replayed).length, synced: results.length } }, { status: 202 });
  } catch (error) { throw invalid(error); }
}

function providerFromPath(request: Request) { const parts = new URL(request.url).pathname.split("/").filter(Boolean); return trackerIssueProvider(parts[parts.indexOf("trackers") + 1] ?? ""); }
async function objectBody(request: Request): Promise<JsonObject> { try { return object(JSON.parse(await request.text() || "{}"), "body"); } catch { throw new HttpError(400, "request body must be valid JSON"); } }
function object(value: unknown, label: string): JsonObject { if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, `${label} must be an object`); return value as JsonObject; }
function text(value: unknown, fallback?: string): string { const output = optionalText(value) || fallback || ""; if (!output) throw new HttpError(400, "required field is missing"); return output; }
function optionalText(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function positiveInteger(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new HttpError(400, "issue_id must be a positive integer"); return value; }
function auditID(body: JsonObject): string { const audit = object(body.audit, "audit"); return text(audit.correlation_id); }
function invalid(error: unknown): HttpError { return error instanceof HttpError ? error : new HttpError(400, error instanceof Error ? error.message : "invalid tracker event"); }
