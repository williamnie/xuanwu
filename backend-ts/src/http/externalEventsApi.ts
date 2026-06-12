import { getExternalEvent, listExternalEvents } from "../db/repositories/externalEvents.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { createFeishuIssueFromExternalEvent } from "../integrations/feishuIssueCreate.ts";
import { ProjectNotFoundError } from "../db/repositories/projects.ts";
import { HttpError, json } from "./errors.ts";
import type { Router } from "./router.ts";

type ExternalEventsApiContext = { database: RunnerDatabase };

export function registerExternalEventRoutes(router: Router, context: ExternalEventsApiContext): void {
  router.get("/api/external-events", (request) => json(listExternalEvents(context.database, eventFilter(request))));
  router.get("/api/external-events/:id", (request) => eventResponse(context, request));
  router.post("/api/external-events/:id/create-issue", async (request) => createIssueResponse(context, request));
}

function eventResponse(context: ExternalEventsApiContext, request: Request): Response {
  const event = getExternalEvent(context.database, eventID(request));
  if (!event) throw new HttpError(404, "external event not found");
  return json(event);
}

async function createIssueResponse(context: ExternalEventsApiContext, request: Request): Promise<Response> {
  const body = await optionalObjectBody(request);
  try {
    const result = createFeishuIssueFromExternalEvent(context.database, eventID(request), body);
    return json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    throw issueCreateHttpError(error);
  }
}

async function optionalObjectBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.trim() === "") return {};
  try {
    const body = JSON.parse(text);
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch {
    throw new HttpError(400, "请求体不是合法 JSON");
  }
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

function issueCreateHttpError(error: unknown): HttpError {
  if (error instanceof ProjectNotFoundError) return new HttpError(404, error.message);
  if (error instanceof Error && error.message === "external event not found") return new HttpError(404, error.message);
  if (error instanceof Error) return new HttpError(400, error.message);
  return new HttpError(400, "failed to create issue from external event");
}
