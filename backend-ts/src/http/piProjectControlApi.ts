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
import { publishNeedsUserFindingNotifications } from "../notifications/piNotifier.ts";
import { createProjectStatusSnapshot } from "../pi/projectSnapshot.ts";
import { diagnoseIssueState } from "../pi/issueStateManager.ts";
import type { PiGatePolicy } from "../pi/actionGate.ts";
import { HttpError, json } from "./errors.ts";
import {
  createPiRuntimeSession,
  ensurePiSessionFile,
  type PiRuntimeSession
} from "./piRuntime.ts";
import { publishPiSessionEvent } from "./piSessionEvents.ts";
import type { Router } from "./router.ts";

type PiProjectControlContext = { bus?: EventBus; database: RunnerDatabase };
type ProjectPiCycleInput = { maxActions?: number; projectId: string };
type ProjectPiControlAction = "pause" | "resume";

const PI_SESSION_PROVIDER = "pi-sdk";
const PI_SESSION_ROLE = "pi_manager";
const activeProjectPiRuns = new Map<string, PiRuntimeSession["session"]>();

export function registerPiProjectControlRoutes(router: Router, context: PiProjectControlContext): void {
  router.post("/api/projects/:id/pi/run-once", (request) => runOnceResponse(context, request));
  router.get("/api/projects/:id/pi/issue-state", (request) => issueStateResponse(context, request));
  router.post("/api/projects/:id/pi/pause", (request) => projectPiSettingsActionResponse(context, request, "pause"));
  router.post("/api/projects/:id/pi/resume", (request) => projectPiSettingsActionResponse(context, request, "resume"));
}


function issueStateResponse(context: PiProjectControlContext, request: Request): Response {
  const id = projectID(request);
  requireProject(context.database, id);
  return json(diagnoseIssueState(context.database, issueStateOptions(id, request)));
}

function issueStateOptions(projectIDValue: string, request: Request) {
  const params = new URL(request.url).searchParams;
  const targetIDs = targetIssueIDs(params);
  if (targetIDs.length === 0) return { projectID: projectIDValue };
  return {
    batchTarget: {
      deadline_at: cleanString(params.get("deadline_at")),
      issue_ids: targetIDs,
      label: cleanString(params.get("target_label")) || "batch",
      status: cleanString(params.get("target_status")) || "done"
    },
    projectID: projectIDValue
  };
}

function targetIssueIDs(params: URLSearchParams): number[] {
  return params.getAll("target_issue_ids").flatMap((value) => value.split(","))
    .map((value) => Number(value.trim())).filter((value) => Number.isSafeInteger(value) && value > 0);
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
  const state = await createManagerCycleState(context, project, agent);
  activeProjectPiRuns.set(project.id, state.runtime.session);
  try {
    return await executeManagerCycle(context, project, cycleSettings, state);
  } finally {
    if (activeProjectPiRuns.get(project.id) === state.runtime.session) activeProjectPiRuns.delete(project.id);
    state.unsubscribe();
    state.runtime.dispose();
  }
}

async function createManagerCycleState(context: PiProjectControlContext, project: Project, agent: PiAgent) {
  const conversationID = crypto.randomUUID();
  const runtime = await createPiRuntimeSession(context.database, {
    agent,
    authorization: managerCycleAuthorization(project.id),
    bus: context.bus,
    conversationID,
    delegationID: `pi-cycle:${project.id}`,
    heartbeatID: `pi-cycle:${project.id}:${conversationID}`,
    project,
    source: "pi_manager_cycle"
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
  return { conversation, runtime, unsubscribe };
}

async function executeManagerCycle(
  context: PiProjectControlContext,
  project: Project,
  settings: ProjectPiSettings,
  state: Awaited<ReturnType<typeof createManagerCycleState>>
) {
  const snapshot = createProjectStatusSnapshot(context.database, project.id);
  const issueState = diagnoseIssueState(context.database, { projectID: project.id });
  await state.runtime.session.prompt(managerCyclePrompt(project, settings, snapshot, issueState), {
    expandPromptTemplates: false,
    source: "rpc"
  });
  await ensurePiSessionFile(state.runtime.session);
  persistPiSessionIndex(context.database, state.conversation, project);
  const notifications = publishNeedsUserFindingNotifications({
    bus: context.bus,
    findings: snapshot.findings,
    notifyOnNeedsUser: settings.notify_on_needs_user !== 0,
    project
  });
  return managerCycleResult(state.conversation, state.runtime.session, settings, snapshot, issueState, notifications);
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

function managerCycleAuthorization(projectID: string): PiGatePolicy {
  return {
    authorizedActions: [
      { action_type: "issue.list", project_id: projectID },
      { action_type: "issue.read", project_id: projectID },
      { action_type: "issue.state_diagnose", project_id: projectID },
      { action_type: "project.list" },
      { action_type: "project.status", project_id: projectID },
      { action_type: "session.list", project_id: projectID },
      { action_type: "session.read_summary", project_id: projectID }
    ],
    mode: "delegated"
  };
}

function managerCyclePrompt(
  project: Project,
  settings: ProjectPiSettings,
  snapshot: ReturnType<typeof createProjectStatusSnapshot>,
  issueState: ReturnType<typeof diagnoseIssueState>
): string {
  return [
    "Run exactly one PI manager cycle for this codex-issue-runner project.",
    `Project id: ${project.id}`,
    `Project name: ${project.name}`,
    "Project status snapshot:",
    JSON.stringify(snapshot, null, 2),
    "Issue state diagnostics:",
    JSON.stringify(issueState, null, 2),
    "Create PI action proposals for concrete next steps; execute only safe read/comment tools.",
    `Do not exceed ${settings.max_actions_per_cycle} action proposals in this cycle.`,
    "Stop after this single cycle and return a concise summary."
  ].join("\n");
}

function managerCycleResult(
  conversation: PiConversation,
  session: PiRuntimeSession["session"],
  settings: ProjectPiSettings,
  snapshot: ReturnType<typeof createProjectStatusSnapshot>,
  issueState: ReturnType<typeof diagnoseIssueState>,
  notifications: ReturnType<typeof publishNeedsUserFindingNotifications>
) {
  return {
    action_candidates: [
      ...snapshot.findings.flatMap((finding) => finding.action_candidate ? [finding.action_candidate] : []),
      ...issueState.diagnostics.flatMap((item) => item.recommended_actions)
    ],
    auto_manage: settings.auto_manage,
    conversation_id: conversation.id,
    message_count: session.state.messages.length,
    issue_state: issueState,
    notifications,
    pi_session_id: session.sessionId,
    project_id: conversation.project_id,
    session_file: session.sessionFile ?? conversation.session_file,
    status: session.state.errorMessage ? "failed" : "completed",
    status_summary: snapshot.compact_summary,
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

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
