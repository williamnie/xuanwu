import { ProjectNotFoundError } from "../db/repositories/projects.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import {
  createFrontendCompatHandlers,
  type CompatBinaryPayload,
  type FrontendCompatContext,
  type FrontendCompatHandlers
} from "./frontendCompatHandlers.ts";
import type { Router } from "./router.ts";

export const FRONTEND_COMPATIBILITY_POLICY = {
  authority: "existing-domain-repositories",
  dualReadWrite: "none",
  removalGate: "G7-and-item-specific-P11-zero-consumer",
  rollback: "restore-prior-route-registry-without-data-migration"
} as const;

export function registerFrontendCompatRoutes(router: Router, context: FrontendCompatContext): void {
  const handlers = createFrontendCompatHandlers(context);
  registerAgentProfileRoutes(router, handlers);
  registerProjectCompatRoutes(router, handlers);
  registerTemplateRoutes(router, handlers);
  registerCronRoutes(router, handlers);
  registerUtilityRoutes(router, handlers);
  registerUploadRoutes(router, handlers);
  registerAdvisoryIssueRoutes(router, handlers);
}

function registerAgentProfileRoutes(router: Router, handlers: FrontendCompatHandlers): void {
  router.post("/api/agent-profiles", async (request) => {
    const body = await objectBody(request);
    return writeResponse(() => handlers.agentProfiles.create(body), 201);
  });
  router.patch("/api/agent-profiles/:id", async (request) => {
    const body = await objectBody(request);
    return writeResponse(() => handlers.agentProfiles.update(lastPathPart(request), body));
  });
  router.delete("/api/agent-profiles/:id", (request) => writeResponse(() => {
    handlers.agentProfiles.delete(lastPathPart(request));
    return null;
  }, 204));
}

function registerProjectCompatRoutes(router: Router, handlers: FrontendCompatHandlers): void {
  router.patch("/api/projects", async (request) => {
    const body = await objectBody(request);
    return writeResponse(() => handlers.projects.reorder(arrayBody(body, "project_ids")));
  });
  router.delete("/api/projects/:id", (request) => writeResponse(() => {
    handlers.projects.delete(projectIDAt(request, 1));
    return null;
  }, 204));
  router.get("/api/projects/:id/loop/status", (request) => json(
    handlers.projects.status(projectIDAt(request, 1))
  ));
  router.post("/api/projects/:id/loop/start", (request) => writeResponse(() => (
    handlers.projects.setLoop(projectIDAt(request, 1), 1)
  )));
  router.post("/api/projects/:id/loop/stop", (request) => writeResponse(() => (
    handlers.projects.setLoop(projectIDAt(request, 1), 0)
  )));
  router.post("/api/projects/:id/hold/resume", (request) => writeResponse(() => (
    handlers.projects.resumeHold(projectIDAt(request, 1))
  )));
  router.get("/api/projects/:id/references/search", (request) => json(
    handlers.projects.references(projectIDAt(request, 1), projectReferenceFilter(request))
  ));
  router.post("/api/projects/sync/codex", () => writeResponse(() => handlers.projects.syncCodex()));
}

function registerTemplateRoutes(router: Router, handlers: FrontendCompatHandlers): void {
  router.post("/api/issue-templates", async (request) => {
    const body = await objectBody(request);
    return writeResponse(() => handlers.issueTemplates.create(body), 201);
  });
  router.get("/api/issue-templates/:id", (request) => writeResponse(() => (
    handlers.issueTemplates.read(lastPathPart(request))
  )));
  router.patch("/api/issue-templates/:id", async (request) => {
    const body = await objectBody(request);
    return writeResponse(() => handlers.issueTemplates.update(lastPathPart(request), body));
  });
  router.delete("/api/issue-templates/:id", (request) => writeResponse(() => {
    handlers.issueTemplates.delete(lastPathPart(request));
    return null;
  }, 204));
}

function registerCronRoutes(router: Router, handlers: FrontendCompatHandlers): void {
  router.post("/api/cron-tasks", async (request) => {
    const body = await objectBody(request);
    return writeResponse(() => handlers.cronTasks.create(body), 201);
  });
  router.patch("/api/cron-tasks/:id", async (request) => {
    const body = await objectBody(request);
    return writeResponse(() => handlers.cronTasks.update(numericID(request, "cron task id 不合法"), body));
  });
  router.delete("/api/cron-tasks/:id", (request) => writeResponse(() => {
    handlers.cronTasks.delete(numericID(request, "cron task id 不合法"));
    return null;
  }, 204));
}

function registerUtilityRoutes(router: Router, handlers: FrontendCompatHandlers): void {
  router.get("/api/notifications", (request) => json(handlers.notifications.list(notificationFilter(request))));
  router.post("/api/notifications/:id/read", (request) => writeResponse(() => (
    handlers.notifications.markRead(notificationID(request))
  )));
  router.get("/api/capabilities", () => json(handlers.capabilities()));
  router.get("/api/codex/models", () => asyncResponse(() => handlers.models()));
  router.post("/api/codex/approvals/:id/resolve", async (request) => {
    const body = await objectBody(request);
    return asyncResponse(() => handlers.approvals.resolve(approvalID(request), body));
  });
  router.post("/api/commands", async (request) => {
    const body = await objectBody(request);
    return writeResponse(() => handlers.commands.execute(body));
  });
  router.post("/api/system/restart", () => json({
    ok: false,
    message: "Bun runtime restart is managed by launchd"
  }, { status: 501 }));
}

function registerUploadRoutes(router: Router, handlers: FrontendCompatHandlers): void {
  router.post("/api/uploads/images", async (request) => asyncResponse(async () => (
    handlers.uploads.createImage(await uploadFile(request))
  ), 201));
  router.get("/api/uploads/:id/content", (request) => binaryResponse(handlers.uploads.content(uploadID(request))));
  router.get("/api/session-images", (request) => binaryResponse(handlers.uploads.sessionImage(
    new URL(request.url).searchParams.get("path") ?? ""
  )));
}

function registerAdvisoryIssueRoutes(router: Router, handlers: FrontendCompatHandlers): void {
  router.post("/api/issues/:id/verifier-report", (request) => writeResponse(() => (
    handlers.issues.verifierReport(issueID(request))
  ), 201));
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

async function uploadFile(request: Request): Promise<File> {
  const file = (await request.formData()).get("file");
  if (!(file instanceof File)) throw new Error("缺少 file 字段");
  return file;
}

async function asyncResponse(write: () => Promise<unknown>, status = 200): Promise<Response> {
  try {
    return json(await write(), { status });
  } catch (error) {
    throw httpError(error);
  }
}

function writeResponse(write: () => unknown, status = 200): Response {
  try {
    const value = write();
    return status === 204 ? new Response(null, { status }) : json(value, { status });
  } catch (error) {
    throw httpError(error);
  }
}

function binaryResponse(payload: CompatBinaryPayload): Response {
  return new Response(payload.body, {
    headers: {
      ...(payload.cacheControl ? { "cache-control": payload.cacheControl } : {}),
      "content-type": payload.contentType
    }
  });
}

function httpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof ProjectNotFoundError) return new HttpError(404, error.message);
  if (error instanceof Error) return new HttpError(400, error.message);
  return new HttpError(400, String(error));
}

function projectReferenceFilter(request: Request): { limit: number; query: string; type: string } {
  const params = new URL(request.url).searchParams;
  return {
    type: params.get("type") ?? "",
    query: params.get("query") ?? "",
    limit: Number(params.get("limit"))
  };
}

function approvalID(request: Request): string { return pathPart(request, 2); }
function uploadID(request: Request): string { return pathPart(request, 1); }
function issueID(request: Request): number { return numericPathPart(request, 1, "issue id 不合法"); }
function notificationID(request: Request): number { return numericPathPart(request, 1, "notification id 不合法"); }
function numericID(request: Request, message: string): number { return numericPathPart(request, 1, message); }
function numericPathPart(request: Request, index: number, message: string): number {
  const id = Number(pathPart(request, index));
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, message);
  return id;
}
function projectIDAt(request: Request, index: number): string {
  const id = pathPart(request, index);
  if (id === "") throw new HttpError(400, "project id 不能为空");
  return id;
}
function lastPathPart(request: Request): string {
  return decodeURIComponent(new URL(request.url).pathname.split("/").filter(Boolean).at(-1) ?? "").trim();
}
function pathPart(request: Request, indexAfterApi: number): string {
  return decodeURIComponent(new URL(request.url).pathname.split("/").filter(Boolean).slice(1)[indexAfterApi] ?? "").trim();
}
function arrayBody(body: Record<string, unknown>, key: string): string[] {
  return Array.isArray(body[key]) ? body[key].map(String) : [];
}
function notificationFilter(request: Request): { projectID: string; unreadOnly: boolean } {
  const params = new URL(request.url).searchParams;
  return {
    projectID: cleanString(params.get("project_id") || params.get("projectId")),
    unreadOnly: params.get("unread") === "1" || params.get("unread") === "true"
  };
}
function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export type { FrontendCompatContext } from "./frontendCompatHandlers.ts";
