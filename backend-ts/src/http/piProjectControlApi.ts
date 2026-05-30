import type { RunnerDatabase } from "../db/database.ts";
import { upsertAgentSession } from "../db/repositories/agentSessions.ts";
import {
  createPiConversation,
  createProjectPiSettings,
  getPiAgent,
  getProjectPiSettings,
  listPiAgents,
  updateProjectPiSettings,
  type PiAgent,
  type PiConversation,
  type ProjectPiSettings
} from "../db/repositories/pi.ts";
import { getProject, type Project } from "../db/repositories/projects.ts";
import type { EventBus } from "../events/bus.ts";
import { createProjectStatusSnapshot } from "../pi/projectSnapshot.ts";
import { HttpError, json } from "./errors.ts";
import {
  createPiRuntimeSession,
  ensurePiSessionFile,
  publishPiSessionEvent,
  type PiRuntimeSession
} from "./piRuntime.ts";
import type { Router } from "./router.ts";

type PiProjectControlContext = { bus?: EventBus; database: RunnerDatabase };
type ProjectPiCycleInput = { maxActions?: number; projectId: string };
type ProjectPiControlAction = "pause" | "resume";

const PI_SESSION_PROVIDER = "pi-sdk";
const PI_SESSION_ROLE = "pi_manager";
const activeProjectPiRuns = new Map<string, PiRuntimeSession["session"]>();

export function registerPiProjectControlRoutes(router: Router, context: PiProjectControlContext): void {
  router.post("/api/projects/:id/pi/run-once", (request) => runOnceResponse(context, request));
  router.post("/api/projects/:id/pi/pause", (request) => projectPiSettingsActionResponse(context, request, "pause"));
  router.post("/api/projects/:id/pi/resume", (request) => projectPiSettingsActionResponse(context, request, "resume"));
}

async function runOnceResponse(context: PiProjectControlContext, request: Request): Promise<Response> {
  return writeResponse(async () => runProjectPiCycle(context, { projectId: projectID(request) }), 201);
}

function projectPiSettingsActionResponse(
  context: PiProjectControlContext,
  request: Request,
  action: ProjectPiControlAction
): Response {
  return json(persistProjectPiAutoManage(context.database, projectID(request), action));
}

export async function runProjectPiCycle(context: PiProjectControlContext, input: ProjectPiCycleInput) {
  const project = requireProject(context.database, input.projectId);
  const settings = readProjectPiSettings(context.database, project.id);
  const cycleSettings = { ...settings, max_actions_per_cycle: input.maxActions ?? settings.max_actions_per_cycle };
  const agent = requireRunnableAgent(context.database, settings.pi_agent_id, "run manager cycle");
  if (activeProjectPiRuns.has(project.id)) throw new HttpError(409, "PI manager cycle is already running");
  const snapshot = createProjectStatusSnapshot(context.database, project.id);

  const conversationID = crypto.randomUUID();
  const runtime = await createPiRuntimeSession(context.database, {
    agent,
    bus: context.bus,
    conversationID,
    project
  });
  const conversation = createPiConversation(context.database, {
    id: conversationID,
    pi_agent_id: agent.id,
    pi_session_id: runtime.session.sessionId,
    project_id: project.id,
    session_file: runtime.session.sessionFile ?? "",
    status: "active",
    title: "PI manager cycle"
  });
  persistPiSessionIndex(context.database, conversation, project);
  const unsubscribe = runtime.session.subscribe((event) => publishPiSessionEvent(context.bus, conversation, event));
  activeProjectPiRuns.set(project.id, runtime.session);
  try {
    await runtime.session.prompt(managerCyclePrompt(project, cycleSettings, snapshot), {
      expandPromptTemplates: false,
      source: "rpc"
    });
    await ensurePiSessionFile(runtime.session);
    persistPiSessionIndex(context.database, conversation, project);
    return managerCycleResult(conversation, runtime.session, cycleSettings);
  } finally {
    if (activeProjectPiRuns.get(project.id) === runtime.session) activeProjectPiRuns.delete(project.id);
    unsubscribe();
    runtime.session.dispose();
  }
}

function persistProjectPiAutoManage(
  db: RunnerDatabase,
  projectID: string,
  action: ProjectPiControlAction
): ProjectPiSettings {
  requireProject(db, projectID);
  const current = getProjectPiSettings(db, projectID);
  const nextAutoManage = action === "resume" ? 1 : 0;
  const next = { ...defaultProjectPiSettings(db, projectID), ...current, auto_manage: nextAutoManage };
  if (action === "resume") requireRunnableAgent(db, next.pi_agent_id, "resume auto-manage");
  if (current) return updateProjectPiSettings(db, projectID, { auto_manage: nextAutoManage });
  if (next.pi_agent_id === "") throw new HttpError(400, "PI agent 不存在");
  return createProjectPiSettings(db, { ...next, project_id: projectID });
}

function readProjectPiSettings(db: RunnerDatabase, projectID: string): ProjectPiSettings {
  return getProjectPiSettings(db, projectID) ?? defaultProjectPiSettings(db, projectID);
}

function defaultProjectPiSettings(db: RunnerDatabase, projectID: string): ProjectPiSettings {
  return {
    project_id: projectID,
    pi_agent_id: defaultPiAgentID(db),
    auto_manage: 0,
    auto_triage: 0,
    auto_enqueue: 0,
    notify_on_needs_user: 1,
    max_actions_per_cycle: 5,
    created_at: "",
    updated_at: ""
  };
}

function requireRunnableAgent(db: RunnerDatabase, id: string, action: string): PiAgent {
  if (id === "") throw new HttpError(400, "PI agent 不存在");
  const agent = getPiAgent(db, id);
  if (!agent) throw new HttpError(400, "PI agent 不存在");
  if (agent.enabled !== 1) throw new HttpError(400, `disabled PI agent cannot ${action}`);
  return agent;
}

function persistPiSessionIndex(db: RunnerDatabase, conversation: PiConversation, project: Project): void {
  upsertAgentSession(db, {
    provider: PI_SESSION_PROVIDER,
    provider_session_id: conversation.pi_session_id,
    agent_role: PI_SESSION_ROLE,
    project_id: project.id,
    title: conversation.title,
    preview: "",
    status: conversation.status,
    raw_ref: { conversation_id: conversation.id, session_file: conversation.session_file }
  });
}

function managerCyclePrompt(
  project: Project,
  settings: ProjectPiSettings,
  snapshot: ReturnType<typeof createProjectStatusSnapshot>
): string {
  return [
    "Run exactly one PI manager cycle for this codex-issue-runner project.",
    `Project id: ${project.id}`,
    `Project name: ${project.name}`,
    "Project status snapshot:",
    JSON.stringify(snapshot, null, 2),
    "Create PI action proposals for concrete next steps; execute only safe read/comment tools.",
    `Do not exceed ${settings.max_actions_per_cycle} action proposals in this cycle.`,
    "Stop after this single cycle and return a concise summary."
  ].join("\n");
}

function managerCycleResult(
  conversation: PiConversation,
  session: PiRuntimeSession["session"],
  settings: ProjectPiSettings
) {
  return {
    auto_manage: settings.auto_manage,
    conversation_id: conversation.id,
    message_count: session.state.messages.length,
    pi_session_id: session.sessionId,
    project_id: conversation.project_id,
    session_file: session.sessionFile ?? conversation.session_file,
    status: session.state.errorMessage ? "failed" : "completed",
    text: session.getLastAssistantText() ?? ""
  };
}

async function writeResponse(write: () => unknown | Promise<unknown>, status = 200): Promise<Response> {
  try {
    return json(await write(), { status });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error) throw new HttpError(400, error.message);
    throw error;
  }
}

function requireProject(db: RunnerDatabase, id: string): Project {
  const project = getProject(db, id);
  if (!project) throw new HttpError(404, "资源不存在");
  return project;
}

function defaultPiAgentID(db: RunnerDatabase): string {
  return listPiAgents(db).find((agent) => agent.enabled === 1)?.id ?? "";
}

function projectID(request: Request): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const value = parts[parts.indexOf("projects") + 1]?.trim() ?? "";
  if (value === "") throw new HttpError(400, "project id 不能为空");
  return decodeURIComponent(value);
}
