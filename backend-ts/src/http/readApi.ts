import type { RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { deleteIssue, enqueueIssue, retryIssue } from "../db/repositories/issueActions.ts";
import { createIssueComment, listIssueEvents } from "../db/repositories/issueEvents.ts";
import { listAgentProfiles } from "../db/repositories/agentProfiles.ts";
import { listIssueTemplates } from "../db/repositories/issueTemplates.ts";
import { listCronTasks } from "../db/repositories/cronTasks.ts";
import { reviewIssueVerification } from "../db/repositories/issueVerification.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { auditIssueSkillIntents } from "../skills/intentAudit.ts";
import { getIssue, listIssueRuns, listIssues, type Issue, type IssueRun } from "../db/repositories/issues.ts";
import {
  createProject,
  getProject,
  listProjects,
  ProjectNotFoundError,
  updateProject
} from "../db/repositories/projects.ts";
import { cancelIssueWithInterrupt } from "../runner/interrupt.ts";
import { startProjectLoop } from "../runner/projectLoopManager.ts";
import type { EventBus } from "../events/bus.ts";
import { registerSessionRoutes } from "./sessionApi.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import { registerPiRoutes } from "./piApi.ts";
import { registerFrontendCompatRoutes } from "./frontendCompatApi.ts";
import { registerUsageRoutes } from "./usageApi.ts";
import type { Router } from "./router.ts";

type ReadApiContext = {
  bus?: EventBus;
  codexSessionsDir?: string;
  database: RunnerDatabase;
  interruptTimeoutMs?: number;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};


export function registerReadApiRoutes(router: Router, context: ReadApiContext): void {
  registerIssuesPageAuxRoutes(router, context);
  registerProjectRoutes(router, context);
  registerIssueCollectionRoutes(router, context);
  registerIssueItemRoutes(router, context);
  registerPiRoutes(router, context);
  registerSessionRoutes(router, context);
  registerFrontendCompatRoutes(router, context);
  registerUsageRoutes(router, context);
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
  router.get("/api/issues", (request) => json(publicIssues(listIssues(context.database, issueFilter(request)))));
  router.post("/api/issues", async (request) => {
    const body = await parseObjectBody(request);
    return writeResponse(() => createIssueAndKickLoop(context, body), 201);
  });
}

function registerIssueItemRoutes(router: Router, context: ReadApiContext): void {
  router.post("/api/issues/:id/enqueue", (request) => actionResponse(context, request, enqueueIssue));
  router.post("/api/issues/:id/retry", (request) => actionResponse(context, request, retryIssue));
  router.post("/api/issues/:id/cancel", (request) => cancelIssueResponse(context, request));
  router.post("/api/issues/:id/verification", async (request) => {
    const body = await parseObjectBody(request);
    return writeResponse(() => reviewIssueVerificationAndKickLoop(context, issueID(request), body));
  });
  router.get("/api/issues/:id", (request) => issueResponse(context, request));
  router.patch("/api/issues/:id", async (request) => {
    const body = await parseObjectBody(request);
    return writeResponse(() => updateIssueAndKickLoop(context, issueID(request), body));
  });
  router.delete("/api/issues/:id", (request) => writeResponse(() => {
    deleteIssue(context.database, issueID(request));
    return null;
  }, 204));
  router.post("/api/issues/:id/comments", async (request) => {
    const body = await parseObjectBody(request);
    return writeResponse(() => createIssueComment(context.database, issueID(request), body), 201);
  });
  router.get("/api/issues/:id/events", (request) => issueEventsResponse(context, request));
  router.get("/api/issues/:id/runs", (request) => issueRunsResponse(context, request));
}

function issueEventsResponse(context: ReadApiContext, request: Request): Response {
  return writeResponse(() => listIssueEvents(context.database, issueID(request)));
}

function issueRunsResponse(context: ReadApiContext, request: Request): Response {
  return writeResponse(() => publicIssueRuns(listIssueRuns(context.database, issueID(request))));
}

function projectResponse(context: ReadApiContext, request: Request): Response {
  const project = getProject(context.database, projectID(request));
  if (!project) throw new HttpError(404, "资源不存在");
  return json(project);
}

function actionResponse(context: ReadApiContext, request: Request, action: IssueAction): Response {
  return writeResponse(() => actionAndKickLoop(context, action, issueID(request)));
}

function createIssueAndKickLoop(context: ReadApiContext, body: Record<string, unknown>): Issue {
  const issue = createIssue(context.database, body);
  if (issue.status === "todo") kickAutoProject(context, issue.project_id);
  return issue;
}

function updateIssueAndKickLoop(context: ReadApiContext, id: number, body: Record<string, unknown>): Issue {
  const issue = updateIssue(context.database, id, body);
  if (terminalForSkillAudit(issue.status)) safeAuditSkillIntents(context.database, issue.id);
  if (shouldKickAfterWrite(issue.status)) kickAutoProject(context, issue.project_id);
  return issue;
}

function reviewIssueVerificationAndKickLoop(context: ReadApiContext, id: number, body: Record<string, unknown>): Issue {
  const issue = reviewIssueVerification(context.database, id, body);
  if (shouldKickAfterWrite(issue.status)) kickAutoProject(context, issue.project_id);
  return issue;
}

type IssueAction = (db: RunnerDatabase, id: number) => unknown;

function actionAndKickLoop(context: ReadApiContext, action: IssueAction, id: number): unknown {
  const output = action(context.database, id);
  if (isQueuedIssue(output)) kickAutoProject(context, output.project_id);
  return output;
}

function kickAutoProject(context: ReadApiContext, projectID: string): void {
  const project = getProject(context.database, projectID);
  if ((project?.auto_run ?? 0) !== 1) return;
  startProjectLoop({ database: context.database, providers: context.providers }, projectID);
}

function isQueuedIssue(value: unknown): value is Issue {
  return Boolean(value && typeof value === "object" && (value as Issue).status === "todo");
}

async function cancelIssueResponse(context: ReadApiContext, request: Request): Promise<Response> {
  return asyncWriteResponse(async () => {
    const issue = await cancelIssueWithInterrupt(context.database, issueID(request), {
      bus: context.bus,
      interruptTimeoutMs: context.interruptTimeoutMs,
      providers: context.providers
    });
    kickAutoProject(context, issue.project_id);
    return issue;
  });
}

function issueResponse(context: ReadApiContext, request: Request): Response {
  const issue = getIssue(context.database, issueID(request));
  if (!issue) throw new HttpError(404, "资源不存在");
  return json(publicIssue(issue));
}

function publicIssues(issues: Issue[]): PublicIssue[] {
  return issues.map(publicIssue);
}

type PublicIssueRun = Omit<IssueRun, "runtime_metadata_json">;
type PublicIssue = Omit<Issue, "latest_run"> & { latest_run?: PublicIssueRun };

function publicIssue(issue: Issue): PublicIssue {
  if (!issue.latest_run) return issue;
  return { ...issue, latest_run: publicIssueRun(issue.latest_run) };
}

function publicIssueRuns(runs: IssueRun[]): PublicIssueRun[] {
  return runs.map(publicIssueRun);
}

function publicIssueRun(run: IssueRun): PublicIssueRun {
  const { runtime_metadata_json: _runtimeMetadata, ...publicRun } = run;
  return publicRun;
}

function registerIssuesPageAuxRoutes(router: Router, context: ReadApiContext): void {
  router.get("/api/agent-profiles", () => json(listAgentProfiles(context.database)));
  router.get("/api/cron-tasks", () => json(listCronTasks(context.database)));
  router.get("/api/issue-templates", () => json(listIssueTemplates(context.database)));
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

function cleanParam(value: string | null): string {
  return value?.trim() ?? "";
}

const LOOP_RELEASE_STATUSES = new Set(["cancelled", "done", "failed", "pending_verification", "todo"]);

function shouldKickAfterWrite(status: string): boolean {
  return LOOP_RELEASE_STATUSES.has(status);
}

function terminalForSkillAudit(status: string): boolean {
  return ["cancelled", "done", "failed", "pending_verification"].includes(status);
}

function safeAuditSkillIntents(db: RunnerDatabase, issueID: number): void {
  try { auditIssueSkillIntents(db, issueID); } catch {}
}
