import type { RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { enqueueIssue, retryIssue } from "../db/repositories/issueActions.ts";
import { createIssueComment, listIssueEvents } from "../db/repositories/issueEvents.ts";
import { reviewIssueVerification } from "../db/repositories/issueVerification.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { getIssue, listIssueRuns, listIssues } from "../db/repositories/issues.ts";
import { createProject, getProject, listProjects, ProjectNotFoundError, updateProject } from "../db/repositories/projects.ts";
import { cancelIssueWithInterrupt, interruptSession } from "../runner/interrupt.ts";
import type { EventBus } from "../events/bus.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

type ReadApiContext = {
  bus?: EventBus;
  database: RunnerDatabase;
  interruptTimeoutMs?: number;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};

const DEFAULT_ISSUE_TEMPLATE = {
  id: "default",
  name: "Default",
  content: "{{issue.description}}",
  is_default: 1
};

export function registerReadApiRoutes(router: Router, context: ReadApiContext): void {
  registerIssuesPageAuxRoutes(router);
  registerProjectRoutes(router, context);
  registerIssueCollectionRoutes(router, context);
  registerIssueItemRoutes(router, context);
}

function registerProjectRoutes(router: Router, context: ReadApiContext): void {
  router.get("/api/projects", () => json(listProjects(context.database)));
  router.get("/api/projects/:id", (request) => projectResponse(context, request));
  router.post("/api/projects", async (request) => {
    const body = await parseProjectBody(request);
    return projectWriteResponse(() => createProject(context.database, body), 201);
  });
  router.patch("/api/projects/:id", async (request) => {
    const body = await parseProjectBody(request);
    return projectWriteResponse(() => updateProject(context.database, projectID(request), body));
  });
}

function registerIssueCollectionRoutes(router: Router, context: ReadApiContext): void {
  router.get("/api/issues", (request) => json(listIssues(context.database, issueFilter(request))));
  router.post("/api/issues", async (request) => {
    const body = await parseObjectBody(request);
    return writeResponse(() => createIssue(context.database, body), 201);
  });
}

function registerIssueItemRoutes(router: Router, context: ReadApiContext): void {
  router.post("/api/issues/:id/enqueue", (request) => actionResponse(context, request, enqueueIssue));
  router.post("/api/issues/:id/retry", (request) => actionResponse(context, request, retryIssue));
  router.post("/api/issues/:id/cancel", (request) => cancelIssueResponse(context, request));
  router.post("/api/issues/:id/verification", async (request) => {
    const body = await parseObjectBody(request);
    return writeResponse(() => reviewIssueVerification(context.database, issueID(request), body));
  });
  router.get("/api/issues/:id", (request) => issueResponse(context, request));
  router.patch("/api/issues/:id", async (request) => {
    const body = await parseObjectBody(request);
    return writeResponse(() => updateIssue(context.database, issueID(request), body));
  });
  router.post("/api/issues/:id/comments", async (request) => {
    const body = await parseObjectBody(request);
    return writeResponse(() => createIssueComment(context.database, issueID(request), body), 201);
  });
  router.get("/api/issues/:id/events", (request) => writeResponse(() => listIssueEvents(context.database, issueID(request))));
  router.get("/api/issues/:id/runs", (request) => writeResponse(() => listIssueRuns(context.database, issueID(request))));
  router.post("/api/sessions/:id/interrupt", (request) => sessionInterruptResponse(context, request));
}

function projectResponse(context: ReadApiContext, request: Request): Response {
  const project = getProject(context.database, projectID(request));
  if (!project) throw new HttpError(404, "资源不存在");
  return json(project);
}

function actionResponse(
  context: ReadApiContext,
  request: Request,
  action: (db: RunnerDatabase, id: number) => unknown
): Response {
  return writeResponse(() => action(context.database, issueID(request)));
}

async function cancelIssueResponse(context: ReadApiContext, request: Request): Promise<Response> {
  return asyncWriteResponse(() => cancelIssueWithInterrupt(context.database, issueID(request), interruptRuntime(context)));
}

async function sessionInterruptResponse(context: ReadApiContext, request: Request): Promise<Response> {
  return asyncWriteResponse(() => interruptSession(context.database, sessionID(request), interruptRuntime(context)));
}

function interruptRuntime(context: ReadApiContext) {
  return {
    bus: context.bus,
    interruptTimeoutMs: context.interruptTimeoutMs,
    providers: context.providers
  };
}

function issueResponse(context: ReadApiContext, request: Request): Response {
  const issue = getIssue(context.database, issueID(request));
  if (!issue) throw new HttpError(404, "资源不存在");
  return json(issue);
}

function registerIssuesPageAuxRoutes(router: Router): void {
  router.get("/api/agent-profiles", () => json([]));
  router.get("/api/cron-tasks", () => json([]));
  router.get("/api/issue-templates", () => json([DEFAULT_ISSUE_TEMPLATE]));
  router.get("/api/nightly-batches", () => json([]));
}

function projectID(request: Request): string {
  const id = new URL(request.url).pathname.split("/").pop()?.trim() ?? "";
  if (id === "") throw new HttpError(400, "project id 不能为空");
  return decodeURIComponent(id);
}

async function parseProjectBody(request: Request): Promise<Record<string, unknown>> {
  return parseObjectBody(request);
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

function projectWriteResponse(write: () => unknown, status = 200): Response {
  return writeResponse(write, status);
}

async function asyncWriteResponse(write: () => Promise<unknown>, status = 200): Promise<Response> {
  try {
    return json(await write(), { status });
  } catch (error) {
    if (error instanceof ProjectNotFoundError) throw new HttpError(404, error.message);
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

function issueID(request: Request): number {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const raw = parts[parts.indexOf("issues") + 1] ?? "";
  if (!/^[0-9]+$/.test(raw)) throw new HttpError(400, "issue id 不合法");
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "issue id 不合法");
  return id;
}

function sessionID(request: Request): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const raw = parts[parts.indexOf("sessions") + 1] ?? "";
  const id = decodeURIComponent(raw).trim();
  if (id === "") throw new HttpError(400, "session id 不能为空");
  return id;
}

function cleanParam(value: string | null): string {
  return value?.trim() ?? "";
}
