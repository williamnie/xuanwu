import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunnerDatabase } from "../db/database.ts";
import { createAgentProfile, deleteAgentProfile, updateAgentProfile } from "../db/repositories/agentProfiles.ts";
import { createCronTask, deleteCronTask, updateCronTask } from "../db/repositories/cronTaskWrites.ts";
import { recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { createIssueTemplate, deleteIssueTemplate, getIssueTemplate, updateIssueTemplate } from "../db/repositories/issueTemplates.ts";
import { getNotificationSettings, saveNotificationSettings } from "../db/repositories/notificationSettings.ts";
import { listNotifications, markNotificationRead } from "../db/repositories/notifications.ts";
import { clearProjectHold, deleteProject, reorderProjects } from "../db/repositories/projectsExtra.ts";
import { getProject, ProjectNotFoundError, updateProject } from "../db/repositories/projects.ts";
import { createImageUpload, mustGetUpload } from "../db/repositories/uploads.ts";
import { enqueueIssue } from "../db/repositories/issueActions.ts";
import { listSkillRegistry } from "../skills/registry.ts";
import { isProjectLoopActive, startProjectLoop as startManagedProjectLoop } from "../runner/projectLoopManager.ts";
import type { EventBus } from "../events/bus.ts";
import { constrainApprovalGrantScope } from "../pi/approvalGrantScope.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import { searchProjectReferences } from "./projectReferences.ts";
import { syncCodexProjects } from "./projectSync.ts";
import type { Router } from "./router.ts";

export type FrontendCompatContext = { bus?: EventBus; codexSessionsDir?: string; database: RunnerDatabase; providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>> };
type CommandPayload = { args?: Record<string, unknown>; name?: string; target?: { id?: string; type?: string }; type?: string };

const loopStates = new Map<string, string>();
export function registerFrontendCompatRoutes(router: Router, context: FrontendCompatContext): void {
  registerAgentProfileRoutes(router, context);
  registerProjectCompatRoutes(router, context);
  registerTemplateRoutes(router, context);
  registerCronRoutes(router, context);
  registerUtilityRoutes(router, context);
  registerUploadRoutes(router, context);
  registerAdvisoryIssueRoutes(router, context);
}

function registerAgentProfileRoutes(router: Router, context: FrontendCompatContext): void {
  router.post("/api/agent-profiles", async (request) => { const body = await objectBody(request); return writeResponse(() => createAgentProfile(context.database, body), 201); });
  router.patch("/api/agent-profiles/:id", async (request) => { const body = await objectBody(request); return writeResponse(() => updateAgentProfile(context.database, lastPathPart(request), body)); });
  router.delete("/api/agent-profiles/:id", (request) => writeResponse(() => { deleteAgentProfile(context.database, lastPathPart(request)); return null; }, 204));
}

function registerProjectCompatRoutes(router: Router, context: FrontendCompatContext): void {
  router.patch("/api/projects", async (request) => { const body = await objectBody(request); return writeResponse(() => reorderProjects(context.database, arrayBody(body, "project_ids"))); });
  router.delete("/api/projects/:id", (request) => writeResponse(() => { deleteProject(context.database, projectIDAt(request, 1)); return null; }, 204));
  router.get("/api/projects/:id/loop/status", (request) => json({ status: projectLoopStatus(context.database, projectIDAt(request, 1)) }));
  router.post("/api/projects/:id/loop/start", (request) => projectLoopResponse(context, projectIDAt(request, 1), 1));
  router.post("/api/projects/:id/loop/stop", (request) => projectLoopResponse(context, projectIDAt(request, 1), 0));
  router.post("/api/projects/:id/hold/resume", (request) => writeResponse(() => clearProjectHold(context.database, projectIDAt(request, 1))));
  router.get("/api/projects/:id/references/search", (request) => projectReferencesResponse(context.database, request));
  router.post("/api/projects/sync/codex", () => writeResponse(() => syncCodexProjects(context.database)));
}

function registerTemplateRoutes(router: Router, context: FrontendCompatContext): void {
  router.post("/api/issue-templates", async (request) => { const body = await objectBody(request); return writeResponse(() => createIssueTemplate(context.database, body), 201); });
  router.get("/api/issue-templates/:id", (request) => writeResponse(() => mustTemplate(context.database, lastPathPart(request))));
  router.patch("/api/issue-templates/:id", async (request) => { const body = await objectBody(request); return writeResponse(() => updateIssueTemplate(context.database, lastPathPart(request), body)); });
  router.delete("/api/issue-templates/:id", (request) => writeResponse(() => { deleteIssueTemplate(context.database, lastPathPart(request)); return null; }, 204));
}

function registerCronRoutes(router: Router, context: FrontendCompatContext): void {
  router.post("/api/cron-tasks", async (request) => { const body = await objectBody(request); return writeResponse(() => createCronTask(context.database, body), 201); });
  router.patch("/api/cron-tasks/:id", async (request) => { const body = await objectBody(request); return writeResponse(() => updateCronTask(context.database, numericID(request, "cron task id 不合法"), body)); });
  router.delete("/api/cron-tasks/:id", (request) => writeResponse(() => { deleteCronTask(context.database, numericID(request, "cron task id 不合法")); return null; }, 204));
}

function registerUtilityRoutes(router: Router, context: FrontendCompatContext): void {
  router.get("/api/notifications", (request) => json(listNotifications(context.database, notificationFilter(request))));
  router.post("/api/notifications/:id/read", (request) => writeResponse(() => markNotificationRead(context.database, notificationID(request))));
  router.get("/api/notifications/settings", () => json(getNotificationSettings(context.database)));
  router.patch("/api/notifications/settings", async (request) => json(saveNotificationSettings(context.database, await objectBody(request))));
  router.get("/api/capabilities", () => json({ skills: listSkillRegistry(), plugins: [] }));
  router.get("/api/codex/models", async () => asyncResponse(async () => await context.providers?.codex?.listModels?.() ?? defaultModels()));
  router.post("/api/codex/approvals/:id/resolve", async (request) => asyncResponse(async () => resolveApproval(context, approvalID(request), await objectBody(request))));
  router.post("/api/commands", async (request) => { const body = await objectBody(request); return writeResponse(() => executeCommand(context, body)); });
  router.post("/api/system/restart", () => json({ ok: false, message: "Bun runtime restart is managed by launchd" }, { status: 501 }));
}

function registerUploadRoutes(router: Router, context: FrontendCompatContext): void {
  router.post("/api/uploads/images", async (request) => asyncResponse(async () => createImageUpload(context.database, stateDir(context.database), await uploadFile(request)), 201));
  router.get("/api/uploads/:id/content", (request) => uploadContentResponse(context.database, uploadID(request)));
  router.get("/api/session-images", (request) => sessionImageResponse(context, request));
}

function registerAdvisoryIssueRoutes(router: Router, context: FrontendCompatContext): void {
  router.post("/api/issues/:id/verifier-report", (request) => writeResponse(() => verifierReport(context.database, issueID(request)), 201));
}

function projectLoopResponse(context: FrontendCompatContext, projectID: string, autoRun: number): Response {
  return writeResponse(() => {
    updateProject(context.database, projectID, { auto_run: autoRun });
    loopStates.set(projectID, autoRun === 1 ? "running" : "stopped");
    if (autoRun === 1 && hasIssueExecutionProvider(context, projectID)) startProjectLoop(context, projectID);
    return { status: autoRun === 1 ? "running" : "stopped" };
  });
}

function hasIssueExecutionProvider(context: FrontendCompatContext, projectID: string): boolean {
  const providerID = getProject(context.database, projectID)?.provider as ExecutorProviderId | undefined;
  const provider = providerID ? context.providers?.[providerID] : undefined;
  return Boolean(provider?.capabilities.includes("issue_execution"));
}

function startProjectLoop(context: FrontendCompatContext, projectID: string): void {
  startManagedProjectLoop({ bus: context.bus, database: context.database, providers: context.providers, onError: logProjectLoopError }, projectID);
}

function projectLoopStatus(db: RunnerDatabase, projectID: string): string {
  const project = getProject(db, projectID);
  if (!project) throw new HttpError(404, "资源不存在");
  if (isProjectLoopActive(projectID)) return "running";
  return loopStates.get(projectID) ?? (project.auto_run === 1 ? "running" : "stopped");
}

function logProjectLoopError(error: unknown, projectID: string): void {
  console.error(JSON.stringify({ ok: false, service: "codex-issue-runner backend-ts", projectId: projectID, error: error instanceof Error ? error.message : String(error) }));
}

function projectReferencesResponse(db: RunnerDatabase, request: Request): Response {
  const project = getProject(db, projectIDAt(request, 1));
  if (!project) throw new HttpError(404, "资源不存在");
  const params = new URL(request.url).searchParams;
  return json(searchProjectReferences(project.cwd, { type: params.get("type") ?? "", query: params.get("query") ?? "", limit: Number(params.get("limit")) }));
}

function executeCommand(context: FrontendCompatContext, body: Record<string, unknown>): Record<string, unknown> {
  const command = normalizeCommand(body.command);
  if (command.name === "status") return statusCommand(context.database, command);
  if (command.name === "issue") return issueCommand(context.database, body, command);
  if (command.name === "run") return runCommand(context.database, command);
  throw new Error(`unsupported command: ${command.name}`);
}

function statusCommand(db: RunnerDatabase, command: CommandPayload): Record<string, unknown> {
  const id = commandIssueID(command);
  const issue = id > 0 ? getIssue(db, id) : null;
  return { command, summary: issue ? `issue #${issue.id} is ${issue.status}` : "runner status", ...(issue ? { issue, runs: listIssueRuns(db, issue.id) } : {}) };
}

function issueCommand(db: RunnerDatabase, body: Record<string, unknown>, command: CommandPayload): Record<string, unknown> {
  const issue = createIssueForCommand(db, body, command);
  return { command, summary: `created triage issue #${issue.id}`, issue };
}

function runCommand(db: RunnerDatabase, command: CommandPayload): Record<string, unknown> {
  if (command.args?.confirmed !== true) throw new Error("/run 需要确认后才能 enqueue issue");
  const issue = enqueueIssue(db, commandIssueID(command));
  return { command, summary: `enqueued issue #${issue.id} as ${issue.status}`, issue };
}

function createIssueForCommand(db: RunnerDatabase, body: Record<string, unknown>, command: CommandPayload) {
  const projectID = cleanString(command.args?.project_id);
  const prompt = cleanString(command.args?.prompt) || cleanString(body.prompt);
  if (projectID === "") throw new Error("/issue 需要选择 project");
  if (prompt === "") throw new Error("/issue 需要 prompt 或 description");
  return createIssue(db, { project_id: projectID, title: cleanString(command.args?.title), description: prompt, status: "triage", source_session_id: cleanString(body.session_id) });
}

function verifierReport(db: RunnerDatabase, id: number): Record<string, unknown> {
  const issue = getIssue(db, id);
  if (!issue) throw new ProjectNotFoundError();
  if (issue.status !== "pending_verification" && !(issue.status === "done" && issue.error.trim() !== "")) throw new Error("只有 pending_verification 或带有弱证据的 done issue 可以生成 verifier report");
  const report = { summary: issue.title, acceptanceChecklist: "需人工复核", evidenceFound: issue.error, evidenceMissing: "smoke evidence", risk: "medium", recommendation: "retry" };
  const event = recordIssueEvent(db, id, "issue.verification_report", { ...report, thread_id: "", turn_id: "" });
  return { report, thread_id: "", turn_id: "", event };
}

async function resolveApproval(context: FrontendCompatContext, id: string, body: Record<string, unknown>): Promise<Record<string, boolean>> {
  const decision = constrainApprovalGrantScope({
    decision: cleanString(body.decision),
    scope: cleanString(body.scope)
  }, { provider: "codex" }).decision;
  if (context.providers?.codex?.resolveApproval) await context.providers.codex.resolveApproval(id, decision);
  return { ok: true };
}

async function objectBody(request: Request): Promise<Record<string, unknown>> {
  try { const body = await parseJsonBody(request); return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {}; }
  catch (error) { if (error instanceof HttpError) throw new HttpError(400, "请求体不是合法 JSON"); throw error; }
}

async function uploadFile(request: Request): Promise<File> {
  const file = (await request.formData()).get("file");
  if (!(file instanceof File)) throw new Error("缺少 file 字段");
  return file;
}

async function asyncResponse(write: () => Promise<unknown>, status = 200): Promise<Response> {
  try { return json(await write(), { status }); }
  catch (error) { throw httpError(error); }
}

function writeResponse(write: () => unknown, status = 200): Response {
  try { const value = write(); return status === 204 ? new Response(null, { status }) : json(value, { status }); }
  catch (error) { throw httpError(error); }
}

function httpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof ProjectNotFoundError) return new HttpError(404, error.message);
  if (error instanceof Error) return new HttpError(400, error.message);
  return new HttpError(400, String(error));
}

function uploadContentResponse(db: RunnerDatabase, id: string): Response {
  const upload = mustGetUpload(db, id);
  return new Response(readFileSync(upload.storage_path), { headers: { "content-type": upload.mime_type } });
}

function sessionImageResponse(context: FrontendCompatContext, request: Request): Response {
  const path = sessionImagePath(context, new URL(request.url).searchParams.get("path") ?? "");
  return new Response(readFileSync(path), {
    headers: {
      "cache-control": "private, max-age=3600",
      "content-type": imageMimeType(path)
    }
  });
}

function sessionImagePath(context: FrontendCompatContext, rawPath: string): string {
  const path = cleanLocalImagePath(rawPath);
  if (path === "" || !isAbsolute(path)) throw new HttpError(400, "session image path 不合法");
  if (!existsSync(path)) throw new HttpError(404, "session image 不存在");
  const real = realpathSync(path);
  if (!statSync(real).isFile() || !isAllowedImage(real)) throw new HttpError(400, "session image path 不合法");
  if (isPathInside(real, context.codexSessionsDir) || isCodexClipboardTempImage(real)) return real;
  throw new HttpError(400, "session image path 不允许访问");
}

function cleanLocalImagePath(value: string): string {
  const raw = value.trim();
  if (!raw.startsWith("file://")) return raw;
  try { return fileURLToPath(raw); } catch { return ""; }
}

function isCodexClipboardTempImage(path: string): boolean {
  return isPathInside(path, tmpdir()) && /^codex-clipboard-[^/\\]+\.(png|jpe?g|webp|gif)$/i.test(basename(path));
}

function isPathInside(path: string, root: string | undefined): boolean {
  const realRoot = safeRealpath(root);
  if (realRoot === "") return false;
  const child = relative(realRoot, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function safeRealpath(path: string | undefined): string {
  const cleanPath = cleanString(path);
  if (cleanPath === "" || !existsSync(cleanPath)) return "";
  return realpathSync(cleanPath);
}

function isAllowedImage(path: string): boolean {
  return [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extname(path).toLowerCase());
}

function imageMimeType(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

function defaultModels(): Record<string, unknown> { return { data: [{ id: "codex-default", model: "codex-default", displayName: "Codex Default", isDefault: true, hidden: false, defaultReasoningEffort: "", supportedReasoningEfforts: [] }] }; }
function mustTemplate(db: RunnerDatabase, id: string) { const item = getIssueTemplate(db, id); if (!item) throw new ProjectNotFoundError(); return item; }
function approvalID(request: Request): string { return pathPart(request, 2); }
function uploadID(request: Request): string { return pathPart(request, 1); }
function issueID(request: Request): number { return numericPathPart(request, 1, "issue id 不合法"); }
function notificationID(request: Request): number { return numericPathPart(request, 1, "notification id 不合法"); }
function numericID(request: Request, message: string): number { return numericPathPart(request, 1, message); }
function numericPathPart(request: Request, index: number, message: string): number { const id = Number(pathPart(request, index)); if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, message); return id; }
function projectIDAt(request: Request, index: number): string { const id = pathPart(request, index); if (id === "") throw new HttpError(400, "project id 不能为空"); return id; }
function lastPathPart(request: Request): string { return decodeURIComponent(new URL(request.url).pathname.split("/").filter(Boolean).at(-1) ?? "").trim(); }
function pathPart(request: Request, indexAfterApi: number): string { return decodeURIComponent(new URL(request.url).pathname.split("/").filter(Boolean).slice(1)[indexAfterApi] ?? "").trim(); }
function arrayBody(body: Record<string, unknown>, key: string): string[] { return Array.isArray(body[key]) ? body[key].map(String) : []; }
function notificationFilter(request: Request): { projectID: string; unreadOnly: boolean } {
  const params = new URL(request.url).searchParams;
  return {
    projectID: cleanString(params.get("project_id") || params.get("projectId")),
    unreadOnly: params.get("unread") === "1" || params.get("unread") === "true"
  };
}
function normalizeCommand(value: unknown): CommandPayload { const raw = value && typeof value === "object" && !Array.isArray(value) ? value as CommandPayload : {}; return { ...raw, name: cleanString(raw.name || raw.type).toLowerCase(), args: raw.args ?? {} }; }
function commandIssueID(command: CommandPayload): number { return Number(command.args?.issue_id ?? command.args?.id ?? command.target?.id ?? 0); }
function stateDir(db: RunnerDatabase): string { return db.path.replace(/\/[^/]+$/, ""); }
function cleanString(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
