import { PI_MANAGER_ROLE } from "../agents/roles.ts";
import type { AgenticWorkerClient } from "../agentic/protocol.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { ensureDefaultPiAgent } from "../db/defaultPiAgent.ts";
import { upsertAgentSession } from "../db/repositories/agentSessions.ts";
import {
  createPiConversation,
  getPiSupervisor,
  getProjectPiSettings,
  updatePiConversation,
  type PiAgent,
  type PiConversation
} from "../db/repositories/pi.ts";
import { getProject, type Project } from "../db/repositories/projects.ts";
import type { EventBus } from "../events/bus.ts";
import { createProjectStatusSnapshot } from "../pi/projectSnapshot.ts";
import { diagnoseIssueState } from "../pi/issueStateManager.ts";
import { parseMcpPolicy } from "../mcp/policy.ts";
import { parseSkillPolicy } from "../skills/intents.ts";
import { HttpError, json } from "./errors.ts";
import { managerCycleAuthorization } from "./piProjectControlAuthorization.ts";
import {
  createPiRuntimeSession,
  ensurePiSessionFile,
  type PiRuntimeSession
} from "./piRuntime.ts";
import { publishPiSessionEvent } from "./piSessionEvents.ts";
import type { Router } from "./router.ts";

type PiProjectControlContext = { agenticClient?: AgenticWorkerClient; bus?: EventBus; database: RunnerDatabase };
type ProjectPiCycleInput = { maxActions?: number; projectId: string };

const PI_SESSION_PROVIDER = "pi-sdk";
const DEFAULT_MANAGER_ACTION_LIMIT = 5;
const activeProjectPiRuns = new Map<string, PiRuntimeSession["session"] | "pending">();

export function registerPiProjectControlRoutes(router: Router, context: PiProjectControlContext): void {
  router.post("/api/projects/:id/pi/run-once", (request) => runOnceResponse(context, request));
  router.get("/api/projects/:id/pi/issue-state", (request) => issueStateResponse(context, request));
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
  const input = { maxActions: DEFAULT_MANAGER_ACTION_LIMIT, projectId: projectID(request) };
  return writeResponse(async () => context.agenticClient
    ? context.agenticClient.runProjectCycle(input)
    : runProjectPiCycle(context, input), 201);
}

export async function runProjectPiCycle(context: PiProjectControlContext, input: ProjectPiCycleInput) {
  const project = requireProject(context.database, input.projectId);
  requireManagedProject(context.database, project.id);
  const maxActions = input.maxActions ?? DEFAULT_MANAGER_ACTION_LIMIT;
  const agent = requireRunnableSupervisor(context.database, "run manager cycle");
  if (activeProjectPiRuns.has(project.id)) throw new HttpError(409, "Supervisor manager cycle is already running");
  activeProjectPiRuns.set(project.id, "pending");
  let state: Awaited<ReturnType<typeof createManagerCycleState>>;
  try {
    state = await createManagerCycleState(context, project, agent);
    activeProjectPiRuns.set(project.id, state.runtime.session);
  } catch (error) {
    if (activeProjectPiRuns.get(project.id) === "pending") activeProjectPiRuns.delete(project.id);
    throw error;
  }
  try {
    return await executeManagerCycle(context, project, maxActions, state);
  } catch (error) {
    finalizeManagerCycle(context.database, state.conversation, project, "failed");
    throw error;
  } finally {
    if (activeProjectPiRuns.get(project.id) === state.runtime.session) activeProjectPiRuns.delete(project.id);
    state.unsubscribe();
    state.runtime.dispose();
  }
}

async function createManagerCycleState(
  context: PiProjectControlContext,
  project: Project,
  agent: PiAgent
) {
  const conversationID = crypto.randomUUID();
  const runtime = await createPiRuntimeSession(context.database, {
    agent,
    authorization: managerCycleAuthorization(project),
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
    title: "Supervisor manager cycle"
  });
  persistPiSessionIndex(context.database, conversation, project);
  const unsubscribe = runtime.session.subscribe((event) => publishPiSessionEvent(context.bus, conversation, event));
  return { conversation, runtime, unsubscribe };
}

async function executeManagerCycle(
  context: PiProjectControlContext,
  project: Project,
  maxActions: number,
  state: Awaited<ReturnType<typeof createManagerCycleState>>
) {
  const snapshot = createProjectStatusSnapshot(context.database, project.id);
  const issueState = diagnoseIssueState(context.database, { projectID: project.id });
  await state.runtime.session.prompt(managerCyclePrompt(project, maxActions, snapshot, issueState), {
    expandPromptTemplates: false,
    source: "rpc"
  });
  await ensurePiSessionFile(state.runtime.session);
  const status = state.runtime.session.state.errorMessage ? "failed" : "completed";
  const conversation = finalizeManagerCycle(context.database, state.conversation, project, status);
  const notifications: never[] = [];
  return managerCycleResult(conversation, state.runtime.session, snapshot, issueState, notifications);
}

function finalizeManagerCycle(
  db: RunnerDatabase,
  conversation: PiConversation,
  project: Project,
  status: "completed" | "failed"
): PiConversation {
  const terminal = updatePiConversation(db, conversation.id, { status });
  persistPiSessionIndex(db, terminal, project);
  return terminal;
}

function requireRunnableSupervisor(db: RunnerDatabase, action: string): PiAgent {
  ensureDefaultPiAgent(db);
  const supervisor = getPiSupervisor(db);
  if (!supervisor) throw new HttpError(500, "Supervisor 配置不可用");
  if (supervisor.enabled !== 1) throw new HttpError(400, `disabled Supervisor cannot ${action}`);
  return supervisor;
}

function persistPiSessionIndex(db: RunnerDatabase, conversation: PiConversation, project: Project): void {
  upsertAgentSession(db, {
    provider: PI_SESSION_PROVIDER,
    provider_session_id: conversation.pi_session_id,
    agent_role: PI_MANAGER_ROLE,
    project_id: project.id,
    title: conversation.title,
    preview: "",
    status: conversation.status,
    raw_ref: { conversation_id: conversation.id, session_file: conversation.session_file }
  });
}

function managerCyclePrompt(
  project: Project,
  maxActions: number,
  snapshot: ReturnType<typeof createProjectStatusSnapshot>,
  issueState: ReturnType<typeof diagnoseIssueState>
): string {
  return [
    "Run exactly one Xuanwu Supervisor manager cycle for this codex-issue-runner project.",
    `Project id: ${project.id}`,
    `Project name: ${project.name}`,
    "Project status snapshot:",
    JSON.stringify(snapshot, null, 2),
    "Issue state diagnostics:",
    JSON.stringify(issueState, null, 2),
    "Agent roles: Supervisor plans/authorizes/schedules; executor executes issues; verifier checks completion evidence; reviewer reviews code/results; reporter summarizes daily/nightly/failures.",
    "Project default skill policy:",
    JSON.stringify(parseSkillPolicy(project.default_skill_policy), null, 2),
    "Project default MCP policy:",
    JSON.stringify(parseMcpPolicy(project.default_mcp_policy), null, 2),
    "Use role workflow tools for executor, verifier, reviewer, reporter proposals when needed; all role actions must go through action gate and audit.",
    "This project is managed by Supervisor. After reading the exact Work and confirming it is complete, authorized, dependency-ready, inside cwd/deadline policy, use work_control action=enqueue with an explicit stable intent idempotency_key. Do not create or enqueue guessed or cross-project Work.",
    "Memory is reusable experience, never a status archive. Do not remember current Work/Run/Issue status, counts, queue emptiness, timestamps, manager-session counts, temporary commitments, or cycle summaries.",
    "Only when an authoritative Handoff/Evidence/Run/Work record contains a reusable bug root cause plus its resolution or verification method, call memory_remember with kind=debugging_pattern or resolution, a stable memory_key, and that authoritative evidence_ref. Repeated observations must reuse the same memory_key.",
    `Do not exceed ${maxActions} action proposals in this cycle.`,
    "Stop after this single cycle and return a concise summary."
  ].join("\n");
}

function managerCycleResult(
  conversation: PiConversation,
  session: PiRuntimeSession["session"],
  snapshot: ReturnType<typeof createProjectStatusSnapshot>,
  issueState: ReturnType<typeof diagnoseIssueState>,
  notifications: readonly never[]
) {
  return {
    managed: true,
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

function requireManagedProject(db: RunnerDatabase, projectID: string): void {
  if (!getProjectPiSettings(db, projectID)) {
    throw new HttpError(409, "project is not managed by Supervisor");
  }
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
