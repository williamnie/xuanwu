import type { RunnerDatabase } from "../db/database.ts";
import { gitEventProvider, upsertGitRepoMapping } from "../db/repositories/gitRepoMappings.ts";
import { syncGitProviderEvent } from "../integrations/gitEvents.ts";
import { HttpError, json } from "./errors.ts";
import type { Router } from "./router.ts";

type GitEventsApiContext = { database: RunnerDatabase };
type JsonObject = Record<string, unknown>;

export function registerGitEventRoutes(router: Router, context: GitEventsApiContext): void {
  router.put("/api/integrations/git/mappings", (request) => mappingResponse(context, request));
  router.post("/api/integrations/git/:provider/events", (request) => eventResponse(context, request, "webhook"));
  router.post("/api/integrations/git/:provider/resync", (request) => resyncResponse(context, request));
}

async function mappingResponse(context: GitEventsApiContext, request: Request): Promise<Response> {
  const body = await objectBody(request);
  try {
    const mapping = upsertGitRepoMapping(context.database, {
      audit: object(body.audit, "audit") as { actor: string; correlation_id: string; event_id: string; reason: string },
      project_id: text(body.project_id), provider: gitEventProvider(body.provider), repository: text(body.repository)
    });
    return json({ mapping }, { status: 201 });
  } catch (error) { throw invalid(error); }
}

async function eventResponse(context: GitEventsApiContext, request: Request, trigger: "manual" | "webhook"): Promise<Response> {
  const payload = await objectBody(request);
  try {
    const result = syncGitProviderEvent(context.database, {
      delivery_id: request.headers.get("x-github-delivery") ?? request.headers.get("x-gitlab-event-uuid") ?? undefined,
      event_name: request.headers.get("x-github-event") ?? request.headers.get("x-gitlab-event") ?? "",
      payload, provider: providerFromPath(request), trigger
    });
    return json({ accepted: true, ...result }, { status: result.replayed ? 200 : 202 });
  } catch (error) { throw invalid(error); }
}

async function resyncResponse(context: GitEventsApiContext, request: Request): Promise<Response> {
  const body = await objectBody(request);
  const events = Array.isArray(body.events) ? body.events : [];
  if (events.length === 0 || events.length > 100) throw new HttpError(400, "events must contain 1 to 100 Git events");
  const provider = providerFromPath(request);
  const results = events.map((value) => {
    const event = object(value, "event");
    return syncGitProviderEvent(context.database, {
      delivery_id: optionalText(event.delivery_id), event_name: text(event.event_name),
      payload: object(event.payload, "event.payload"), provider, trigger: "manual"
    });
  });
  return json({ accepted: true, provider, results, summary: {
    attention: results.filter((item) => !item.linked).length,
    replayed: results.filter((item) => item.replayed).length,
    synced: results.length
  } }, { status: 202 });
}

function providerFromPath(request: Request) {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  return gitEventProvider(parts[parts.indexOf("git") + 1] ?? "");
}
async function objectBody(request: Request): Promise<JsonObject> {
  try { return object(JSON.parse(await request.text() || "{}"), "body"); }
  catch { throw new HttpError(400, "request body must be valid JSON"); }
}
function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, `${label} must be an object`);
  return value as JsonObject;
}
function text(value: unknown): string { const output = optionalText(value); if (!output) throw new HttpError(400, "required field is missing"); return output; }
function optionalText(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function invalid(error: unknown): HttpError { return error instanceof HttpError ? error : new HttpError(400, error instanceof Error ? error.message : "invalid Git event"); }
