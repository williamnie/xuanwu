import type { RunnerDatabase } from "../db/database.ts";
import { getIssue, listIssues } from "../db/repositories/issues.ts";
import { createProject, listProjects, ProjectNotFoundError, updateProject } from "../db/repositories/projects.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

type ReadApiContext = { database: RunnerDatabase };

export function registerReadApiRoutes(router: Router, context: ReadApiContext): void {
  router.get("/api/projects", () => json(listProjects(context.database)));
  router.post("/api/projects", async (request) => {
    const body = await parseProjectBody(request);
    return projectWriteResponse(() => createProject(context.database, body), 201);
  });
  router.patch("/api/projects/:id", async (request) => {
    const body = await parseProjectBody(request);
    return projectWriteResponse(() => updateProject(context.database, projectID(request), body));
  });
  router.get("/api/issues", (request) => json(listIssues(context.database, issueFilter(request))));
  router.get("/api/issues/:id", (request) => {
    const issue = getIssue(context.database, issueID(request));
    if (!issue) throw new HttpError(404, "资源不存在");
    return json(issue);
  });
}

function projectID(request: Request): string {
  const id = new URL(request.url).pathname.split("/").pop()?.trim() ?? "";
  if (id === "") throw new HttpError(400, "project id 不能为空");
  return decodeURIComponent(id);
}

async function parseProjectBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await parseJsonBody(request);
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch (error) {
    if (error instanceof HttpError) throw new HttpError(400, "请求体不是合法 JSON");
    throw error;
  }
}

function projectWriteResponse(write: () => unknown, status = 200): Response {
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
  const raw = new URL(request.url).pathname.split("/").pop() ?? "";
  if (!/^[0-9]+$/.test(raw)) throw new HttpError(400, "issue id 不合法");
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "issue id 不合法");
  return id;
}

function cleanParam(value: string | null): string {
  return value?.trim() ?? "";
}
