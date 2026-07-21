import type { RunnerDatabase } from "../db/database.ts";
import { ProjectNotFoundError } from "../db/repositories/projects.ts";
import { queryEventSummaries } from "../events/eventSummaryQuery.ts";
import { HttpError, json } from "./errors.ts";
import type { Router } from "./router.ts";

type EventSummariesContext = { database: RunnerDatabase; readDatabase?: RunnerDatabase };

export function registerEventSummaryRoutes(router: Router, context: EventSummariesContext): void {
  router.get("/api/event-summaries", (request) => eventSummaryResponse(() => queryEventSummaries(
    context.readDatabase ?? context.database,
    eventSummaryFilter(request, 100)
  )));
  router.get("/api/issues/:id/event-summaries", (request) => eventSummaryResponse(() => queryEventSummaries(
    context.readDatabase ?? context.database,
    { ...eventSummaryFilter(request), issueID: issueID(request) }
  )));
}

function eventSummaryResponse(read: () => unknown): Response {
  try {
    return json(read());
  } catch (error) {
    if (error instanceof ProjectNotFoundError) throw new HttpError(404, error.message);
    throw error;
  }
}

function eventSummaryFilter(request: Request, defaultLimit?: number) {
  const params = new URL(request.url).searchParams;
  const beforeID = optionalPositiveInteger(params.get("before_id"), "before_id");
  const afterID = optionalPositiveInteger(params.get("after_id"), "after_id");
  if (beforeID !== undefined && afterID !== undefined) {
    throw new HttpError(400, "before_id 和 after_id 不能同时使用");
  }
  return {
    afterID,
    beforeID,
    excludeTypes: eventTypes(params, "exclude_type"),
    limit: optionalPositiveInteger(params.get("limit"), "limit", 500) ?? defaultLimit,
    projectID: clean(params.get("project_id") || params.get("projectId")),
    types: eventTypes(params, "type")
  };
}

function issueID(request: Request): number {
  const match = /^\/api\/issues\/(\d+)\/event-summaries$/.exec(new URL(request.url).pathname);
  if (!match) throw new HttpError(400, "issue id 必须是正整数");
  return Number(match[1]);
}

function eventTypes(params: URLSearchParams, key: string): string[] {
  return params.getAll(key)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function optionalPositiveInteger(value: string | null, label: string, maximum?: number): number | undefined {
  const raw = clean(value);
  if (!raw) return undefined;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, `${label} 必须是正整数`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new HttpError(400, `${label} 必须是正整数`);
  if (maximum !== undefined && parsed > maximum) throw new HttpError(400, `${label} 不能大于 ${maximum}`);
  return parsed;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
