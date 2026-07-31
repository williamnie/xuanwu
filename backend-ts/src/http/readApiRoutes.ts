import type { IssueActionOptions } from "../db/repositories/issueActions.ts";
import type { ListIssueEventsOptions } from "../db/repositories/issueEvents.ts";
import { ProjectNotFoundError } from "../db/repositories/projects.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import { createReadApiDomainHandlers, type ReadApiDomainHandlers } from "./readApiDomain.ts";
import type { ReadApiContext } from "./readApiContext.ts";
import type { Router } from "./router.ts";
import { HumanReviewConflictError } from "../domain/review/humanReview.ts";

export function registerCoreReadRoutes(router: Router, context: ReadApiContext): void {
  const handlers = createReadApiDomainHandlers(context);
  const readHandlers = context.readDatabase
    ? createReadApiDomainHandlers({ ...context, database: context.readDatabase })
    : handlers;
  registerIssuesPageAuxRoutes(router, readHandlers);
  registerProjectRoutes(router, handlers, readHandlers);
  registerIssueCollectionRoutes(router, handlers, readHandlers);
  registerIssueItemRoutes(router, handlers, readHandlers);
}

function registerIssuesPageAuxRoutes(router: Router, handlers: ReadApiDomainHandlers): void {
  router.get("/api/agent-profiles", () => json(handlers.auxiliary.listAgentProfiles()));
}

function registerProjectRoutes(router: Router, handlers: ReadApiDomainHandlers, readHandlers = handlers): void {
  router.get("/api/projects", () => json(readHandlers.projects.list()));
  router.get("/api/projects/:id", (request) => readResponse(() => readHandlers.projects.read(projectID(request))));
  router.post("/api/projects", async (request) => {
    const body = await parseObjectBody(request);
    return writeResponse(() => handlers.projects.create(body), 201);
  });
  router.patch("/api/projects/:id", async (request) => {
    const body = await parseObjectBody(request);
    return writeResponse(() => handlers.projects.update(projectID(request), body));
  });
}

function registerIssueCollectionRoutes(router: Router, handlers: ReadApiDomainHandlers, readHandlers = handlers): void {
  router.get("/api/issues", (request) => json(readHandlers.issues.list(issueFilter(request))));
  router.post("/api/issues", async (request) => {
    const body = await parseObjectBody(request);
    return writeResponse(() => handlers.issues.create(body), 201);
  });
}

function registerIssueItemRoutes(router: Router, handlers: ReadApiDomainHandlers, readHandlers = handlers): void {
  router.post("/api/issues/:id/enqueue", (request) => actionResponse(handlers, request, "enqueue"));
  router.post("/api/issues/:id/retry", (request) => actionResponse(handlers, request, "retry"));
  router.post("/api/issues/:id/cancel", (request) => asyncWriteResponse(() => handlers.issues.cancel(issueID(request))));
  router.post("/api/issues/:id/verification", async (request) => {
    const body = await parseObjectBody(request);
    return asyncWriteResponse(() => handlers.issues.verify(issueID(request), body));
  });
  router.post("/api/issues/:id/human-review-requests", async (request) => {
    const body = await parseObjectBody(request);
    return writeResponse(() => handlers.issues.requestHumanReview(issueID(request), body), 201);
  });
  router.get("/api/issues/:id", (request) => readResponse(() => readHandlers.issues.read(issueID(request))));
  router.patch("/api/issues/:id", async (request) => {
    const body = await parseObjectBody(request);
    return asyncWriteResponse(() => handlers.issues.update(issueID(request), body));
  });
  router.delete("/api/issues/:id", (request) => writeResponse(() => {
    handlers.issues.delete(issueID(request));
    return null;
  }, 204));
  router.post("/api/issues/:id/comments", async (request) => {
    const body = await parseObjectBody(request);
    return writeResponse(() => handlers.issues.comment(issueID(request), body), 201);
  });
  router.get("/api/issues/:id/events", (request) => asyncWriteResponse(() => (
    readHandlers.issues.events(issueID(request), issueEventFilter(request))
  )));
  router.get("/api/issues/:id/runs", (request) => writeResponse(() => readHandlers.issues.runs(issueID(request))));
}

async function actionResponse(
  handlers: ReadApiDomainHandlers,
  request: Request,
  action: "enqueue" | "retry"
): Promise<Response> {
  const body = await parseOptionalObjectBody(request);
  const id = issueID(request);
  const options = actionOptions(body);
  return asyncWriteResponse(async () => handlers.issues[action](id, options));
}

function readResponse(read: () => unknown): Response {
  try {
    return json(read());
  } catch (error) {
    if (error instanceof ProjectNotFoundError) throw new HttpError(404, error.message);
    throw error;
  }
}

async function parseObjectBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await parseJsonBody(request);
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch (error) {
    if (error instanceof HttpError) throw new HttpError(400, "请求体不是合法 JSON");
    throw error;
  }
}

async function parseOptionalObjectBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.trim() === "") return {};
  try {
    const body = JSON.parse(text);
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch {
    throw new HttpError(400, "请求体不是合法 JSON");
  }
}

async function asyncWriteResponse(write: () => Promise<unknown>, status = 200): Promise<Response> {
  try {
    return json(await write(), { status });
  } catch (error) {
    if (error instanceof ProjectNotFoundError) throw new HttpError(404, error.message);
    if (error instanceof HumanReviewConflictError) throw new HttpError(409, error.message);
    if (error instanceof HttpError) throw error;
    if (error instanceof Error) throw new HttpError(400, error.message);
    throw error;
  }
}

function writeResponse(write: () => unknown, status = 200): Response {
  try {
    return json(write(), { status });
  } catch (error) {
    if (error instanceof ProjectNotFoundError) throw new HttpError(404, error.message);
    if (error instanceof Error) throw new HttpError(400, error.message);
    throw error;
  }
}

function issueFilter(request: Request): { projectId: string; sourceSessionId: string; status: string } {
  const params = new URL(request.url).searchParams;
  return {
    projectId: cleanParam(params.get("projectId")),
    sourceSessionId: cleanParam(params.get("sourceSessionId") || params.get("source_session_id")),
    status: cleanParam(params.get("status"))
  };
}

function issueEventFilter(request: Request): ListIssueEventsOptions {
  const params = new URL(request.url).searchParams;
  const beforeID = optionalPositiveIntegerParam(params, "before_id");
  const afterID = optionalPositiveIntegerParam(params, "after_id");
  if (beforeID !== undefined && afterID !== undefined) {
    throw new HttpError(400, "before_id 和 after_id 不能同时使用");
  }
  return {
    afterID,
    beforeID,
    excludeTypes: eventTypeParams(params, "exclude_type"),
    limit: optionalPositiveIntegerParam(params, "limit", 500),
    types: eventTypeParams(params, "type")
  };
}

function eventTypeParams(params: URLSearchParams, key: string): string[] {
  return params.getAll(key)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function optionalPositiveIntegerParam(params: URLSearchParams, key: string, maximum?: number): number | undefined {
  const raw = cleanParam(params.get(key));
  if (raw === "") return undefined;
  if (!/^[0-9]+$/.test(raw)) throw new HttpError(400, `${key} 必须是正整数`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new HttpError(400, `${key} 必须是正整数`);
  if (maximum !== undefined && value > maximum) {
    throw new HttpError(400, `${key} 不能大于 ${maximum}`);
  }
  return value;
}

function actionOptions(body: Record<string, unknown>): IssueActionOptions {
  return Object.hasOwn(body, "service_tier")
    ? { serviceTier: stringBody(body.service_tier), serviceTierProvided: true }
    : {};
}

function projectID(request: Request): string {
  const id = new URL(request.url).pathname.split("/").pop()?.trim() ?? "";
  if (id === "") throw new HttpError(400, "project id 不能为空");
  return decodeURIComponent(id);
}

function issueID(request: Request): number {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const raw = parts[parts.indexOf("issues") + 1] ?? "";
  if (!/^[0-9]+$/.test(raw)) throw new HttpError(400, "issue id 不合法");
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "issue id 不合法");
  return id;
}

function cleanParam(value: string | null): string {
  return value?.trim() ?? "";
}

function stringBody(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
