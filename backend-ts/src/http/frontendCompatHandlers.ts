import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunnerDatabase } from "../db/database.ts";
import { createAgentProfile, deleteAgentProfile, updateAgentProfile } from "../db/repositories/agentProfiles.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
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
import { HttpError } from "./errors.ts";
import { searchProjectReferences } from "./projectReferences.ts";
import { syncCodexProjects } from "./projectSync.ts";

export type FrontendCompatContext = {
  bus?: EventBus;
  codexSessionsDir?: string;
  database: RunnerDatabase;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};

export type CompatBinaryPayload = {
  body: ReturnType<typeof readFileSync>;
  cacheControl?: string;
  contentType: string;
};

type CommandPayload = {
  args?: Record<string, unknown>;
  name?: string;
  target?: { id?: string; type?: string };
  type?: string;
};

const loopStates = new Map<string, string>();

export function createFrontendCompatHandlers(context: FrontendCompatContext) {
  return {
    agentProfiles: {
      create: (body: Record<string, unknown>) => createAgentProfile(context.database, body),
      delete: (id: string) => deleteAgentProfile(context.database, id),
      update: (id: string, body: Record<string, unknown>) => updateAgentProfile(context.database, id, body)
    },
    approvals: {
      resolve: (id: string, body: Record<string, unknown>) => resolveApproval(context, id, body)
    },
    capabilities: () => ({ skills: listSkillRegistry(), plugins: [] }),
    commands: {
      execute: (body: Record<string, unknown>) => executeCommand(context, body)
    },
    models: () => context.providers?.codex?.listModels?.() ?? Promise.resolve(defaultModels()),
    notifications: {
      list: (filter: { projectID: string; unreadOnly: boolean }) => listNotifications(context.database, filter),
      markRead: (id: number) => markNotificationRead(context.database, id)
    },
    projects: {
      delete: (id: string) => deleteProject(context.database, id),
      references: (id: string, input: { limit: number; query: string; type: string }) => (
        projectReferences(context.database, id, input)
      ),
      reorder: (ids: string[]) => reorderProjects(context.database, ids),
      resumeHold: (id: string) => clearProjectHold(context.database, id),
      setLoop: (id: string, autoRun: number) => setProjectLoop(context, id, autoRun),
      status: (id: string) => ({ status: projectLoopStatus(context.database, id) }),
      syncCodex: () => syncCodexProjects(context.database)
    },
    uploads: {
      content: (id: string) => uploadContent(context.database, id),
      createImage: (file: File) => createImageUpload(context.database, stateDir(context.database), file),
      sessionImage: (path: string) => sessionImage(context, path)
    }
  };
}

export type FrontendCompatHandlers = ReturnType<typeof createFrontendCompatHandlers>;

function setProjectLoop(context: FrontendCompatContext, projectID: string, autoRun: number): { status: string } {
  updateProject(context.database, projectID, { auto_run: autoRun });
  loopStates.set(projectID, autoRun === 1 ? "running" : "stopped");
  if (autoRun === 1 && hasIssueExecutionProvider(context, projectID)) startProjectLoop(context, projectID);
  return { status: autoRun === 1 ? "running" : "stopped" };
}

function hasIssueExecutionProvider(context: FrontendCompatContext, projectID: string): boolean {
  const providerID = getProject(context.database, projectID)?.provider as ExecutorProviderId | undefined;
  const provider = providerID ? context.providers?.[providerID] : undefined;
  return Boolean(provider?.capabilities.includes("issue_execution"));
}

function startProjectLoop(context: FrontendCompatContext, projectID: string): void {
  startManagedProjectLoop({
    bus: context.bus,
    database: context.database,
    providers: context.providers,
    onError: logProjectLoopError
  }, projectID);
}

function projectLoopStatus(db: RunnerDatabase, projectID: string): string {
  const project = getProject(db, projectID);
  if (!project) throw new HttpError(404, "资源不存在");
  if (isProjectLoopActive(projectID)) return "running";
  return loopStates.get(projectID) ?? (project.auto_run === 1 ? "running" : "stopped");
}

function logProjectLoopError(error: unknown, projectID: string): void {
  console.error(JSON.stringify({
    ok: false,
    service: "codex-issue-runner backend-ts",
    projectId: projectID,
    error: error instanceof Error ? error.message : String(error)
  }));
}

function projectReferences(
  db: RunnerDatabase,
  projectID: string,
  input: { limit: number; query: string; type: string }
) {
  const project = getProject(db, projectID);
  if (!project) throw new HttpError(404, "资源不存在");
  return searchProjectReferences(project.cwd, input);
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
  return {
    command,
    summary: issue ? `issue #${issue.id} is ${issue.status}` : "runner status",
    ...(issue ? { issue, runs: listIssueRuns(db, issue.id) } : {})
  };
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
  return createIssue(db, {
    project_id: projectID,
    title: cleanString(command.args?.title),
    description: prompt,
    status: "triage",
    source_session_id: cleanString(body.session_id)
  });
}

async function resolveApproval(
  context: FrontendCompatContext,
  id: string,
  body: Record<string, unknown>
): Promise<Record<string, boolean>> {
  const decision = constrainApprovalGrantScope({
    decision: cleanString(body.decision),
    scope: cleanString(body.scope)
  }, { provider: "codex" }).decision;
  if (context.providers?.codex?.resolveApproval) await context.providers.codex.resolveApproval(id, decision);
  return { ok: true };
}

function uploadContent(db: RunnerDatabase, id: string): CompatBinaryPayload {
  const upload = mustGetUpload(db, id);
  return { body: readFileSync(upload.storage_path), contentType: upload.mime_type };
}

function sessionImage(context: FrontendCompatContext, rawPath: string): CompatBinaryPayload {
  const path = sessionImagePath(context, rawPath);
  return {
    body: readFileSync(path),
    cacheControl: "private, max-age=3600",
    contentType: imageMimeType(path)
  };
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

function defaultModels(): Record<string, unknown> {
  return {
    data: [{
      id: "codex-default",
      model: "codex-default",
      displayName: "Codex Default",
      isDefault: true,
      hidden: false,
      defaultReasoningEffort: "",
      supportedReasoningEfforts: []
    }]
  };
}

function normalizeCommand(value: unknown): CommandPayload {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as CommandPayload : {};
  return { ...raw, name: cleanString(raw.name || raw.type).toLowerCase(), args: raw.args ?? {} };
}

function commandIssueID(command: CommandPayload): number {
  return Number(command.args?.issue_id ?? command.args?.id ?? command.target?.id ?? 0);
}

function stateDir(db: RunnerDatabase): string {
  return db.path.replace(/\/[^/]+$/, "");
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
