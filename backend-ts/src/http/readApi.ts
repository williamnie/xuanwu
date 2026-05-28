import type { RunnerDatabase } from "../db/database.ts";
import { getIssue, listIssues } from "../db/repositories/issues.ts";
import { listProjects } from "../db/repositories/projects.ts";
import { HttpError, json } from "./errors.ts";
import type { Router } from "./router.ts";

type ReadApiContext = { database: RunnerDatabase };

export function registerReadApiRoutes(router: Router, context: ReadApiContext): void {
  router.get("/api/projects", () => json(listProjects(context.database)));
  router.get("/api/issues", (request) => json(listIssues(context.database, issueFilter(request))));
  router.get("/api/issues/:id", (request) => {
    const issue = getIssue(context.database, issueID(request));
    if (!issue) throw new HttpError(404, "资源不存在");
    return json(issue);
  });
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
