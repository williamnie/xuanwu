import { getExternalEvent, listExternalEvents } from "../db/repositories/externalEvents.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { HttpError, json } from "./errors.ts";
import type { Router } from "./router.ts";

type ExternalEventsApiContext = { database: RunnerDatabase };

export function registerExternalEventRoutes(router: Router, context: ExternalEventsApiContext): void {
  router.get("/api/external-events", (request) => json(listExternalEvents(context.database, eventFilter(request))));
  router.get("/api/external-events/:id", (request) => eventResponse(context, request));
}

function eventResponse(context: ExternalEventsApiContext, request: Request): Response {
  const event = getExternalEvent(context.database, eventID(request));
  if (!event) throw new HttpError(404, "external event not found");
  return json(event);
}

function eventFilter(request: Request): { dedupeKey: string; limit?: number; source: string } {
  const params = new URL(request.url).searchParams;
  return {
    dedupeKey: cleanParam(params.get("dedupe_key") || params.get("dedupeKey")),
    limit: positiveQueryInt(params.get("limit")),
    source: cleanParam(params.get("source"))
  };
}

function eventID(request: Request): number {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const raw = parts[parts.indexOf("external-events") + 1] ?? "";
  if (!/^[0-9]+$/.test(raw)) throw new HttpError(400, "external event id 不合法");
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "external event id 不合法");
  return id;
}

function cleanParam(value: string | null): string {
  return value?.trim() ?? "";
}

function positiveQueryInt(value: string | null): number | undefined {
  const text = cleanParam(value);
  if (!/^[0-9]+$/.test(text)) return undefined;
  const number = Number(text);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}
