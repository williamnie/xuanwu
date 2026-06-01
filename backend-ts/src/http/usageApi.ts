import type { RunnerDatabase } from "../db/database.ts";
import { listIssues, type Issue } from "../db/repositories/issues.ts";
import { listProjects } from "../db/repositories/projects.ts";
import { readCodexUsage } from "../usage/codex.ts";
import type { UsageIssueRef, UsageProjectRef } from "../usage/types.ts";
import { HttpError, json } from "./errors.ts";
import type { Router } from "./router.ts";

type UsageApiContext = {
  codexSessionsDir?: string;
  database: RunnerDatabase;
};

export function registerUsageRoutes(router: Router, context: UsageApiContext): void {
  router.get("/api/usage/codex", async (request) => json(await safeUsageReport(context, request)));
}

async function safeUsageReport(context: UsageApiContext, request: Request): Promise<Record<string, unknown>> {
  try {
    return await usageReport(context, request);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error) throw new HttpError(400, error.message);
    throw error;
  }
}

async function usageReport(context: UsageApiContext, request: Request): Promise<Record<string, unknown>> {
  return await readCodexUsage({
    options: {
      issues: issueRefs(listIssues(context.database)),
      limit: usageLimit(request),
      projects: projectRefs(context.database)
    },
    root: context.codexSessionsDir ?? ""
  });
}

function projectRefs(db: RunnerDatabase): UsageProjectRef[] {
  return listProjects(db).map((project) => ({
    cwd: project.cwd,
    id: project.id,
    name: project.name
  }));
}

function issueRefs(issues: Issue[]): UsageIssueRef[] {
  return issues.map(issueRef).filter((issue) => issue.session_id !== "");
}

function issueRef(issue: Issue): UsageIssueRef {
  return {
    id: issue.id,
    project_id: issue.project_id,
    session_id: issue.codex_thread_id || issue.latest_run?.provider_session_id || issue.latest_run?.codex_thread_id || "",
    status: issue.status,
    title: issue.title
  };
}

function usageLimit(request: Request): number {
  const raw = new URL(request.url).searchParams.get("limit")?.trim();
  if (!raw) return 0;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 0) throw new HttpError(400, "limit 必须是非负整数");
  return limit;
}
