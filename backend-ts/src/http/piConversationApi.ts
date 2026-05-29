import type { RunnerDatabase } from "../db/database.ts";
import { upsertAgentSession } from "../db/repositories/agentSessions.ts";
import {
  createPiConversation,
  getPiAgent,
  getPiConversation,
  listPiAgents,
  listPiConversations,
  type PiAgent,
  type PiConversation
} from "../db/repositories/pi.ts";
import { getProject, type Project } from "../db/repositories/projects.ts";
import type { EventBus } from "../events/bus.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import {
  createOrRestorePiRuntime,
  createPiRuntimeSession,
  publishPiSessionEvent,
  type PiRuntimeResult,
  type PiRuntimeSession
} from "./piRuntime.ts";
import type { Router } from "./router.ts";

type PiConversationContext = { bus?: EventBus; database: RunnerDatabase };

const PI_SESSION_PROVIDER = "pi-sdk";
const PI_SESSION_ROLE = "pi_manager";
const activePiRuns = new Map<string, PiRuntimeSession["session"]>();

export function registerPiConversationRoutes(router: Router, context: PiConversationContext): void {
  router.get("/api/pi/conversations", (request) => piConversationListResponse(context, request));
  router.post("/api/pi/conversations", async (request) => piConversationCreateResponse(context, request));
  router.get("/api/pi/conversations/:id", (request) => piConversationResponse(context, request));
  router.post("/api/pi/conversations/:id/messages", async (request) => piConversationMessageResponse(context, request));
  router.post("/api/pi/conversations/:id/interrupt", (request) => piConversationInterruptResponse(context, request));
}

function piConversationListResponse(context: PiConversationContext, request: Request): Response {
  const params = new URL(request.url).searchParams;
  return json(listPiConversations(context.database, {
    projectId: cleanString(params.get("project_id")),
    status: cleanString(params.get("status"))
  }));
}

async function piConversationCreateResponse(context: PiConversationContext, request: Request): Promise<Response> {
  const body = await parseObjectBody(request);
  return writeResponse(async () => createConversationWithRuntime(context, body), 201);
}

function piConversationResponse(context: PiConversationContext, request: Request): Response {
  const conversation = getPiConversation(context.database, pathPart(request, "conversations"));
  if (!conversation) throw new HttpError(404, "资源不存在");
  return json(conversation);
}

async function piConversationMessageResponse(context: PiConversationContext, request: Request): Promise<Response> {
  const body = await parseObjectBody(request);
  const id = pathPart(request, "conversations");
  return writeResponse(() => sendPiConversationMessage(context, id, body), 201);
}

async function piConversationInterruptResponse(context: PiConversationContext, request: Request): Promise<Response> {
  const id = pathPart(request, "conversations");
  return writeResponse(() => interruptPiConversation(context, id));
}

async function createConversationWithRuntime(
  context: PiConversationContext,
  body: Record<string, unknown>
): Promise<PiConversation> {
  const project = conversationProject(context.database, cleanString(body.project_id));
  const agent = conversationAgent(context.database, cleanString(body.pi_agent_id));
  const id = cleanString(body.id) || crypto.randomUUID();
  const runtime = await createOrRestorePiRuntime(context.database, { agent, conversationID: id, project });
  const conversation = createPiConversation(context.database, conversationInput({
    body,
    id,
    piAgentID: agent.id,
    projectID: project.id,
    runtime
  }));
  persistPiSessionIndex(context.database, conversation, project);
  return conversation;
}

function conversationInput(input: {
  body: Record<string, unknown>;
  id: string;
  piAgentID: string;
  projectID: string;
  runtime: PiRuntimeResult;
}): Record<string, unknown> {
  return {
    id: input.id,
    pi_agent_id: input.piAgentID,
    pi_session_id: input.runtime.piSessionId,
    project_id: input.projectID,
    session_file: input.runtime.sessionFile,
    status: cleanString(input.body.status) || "active",
    title: cleanString(input.body.title)
  };
}

async function sendPiConversationMessage(
  context: PiConversationContext,
  id: string,
  body: Record<string, unknown>
) {
  const prompt = cleanString(body.prompt || body.message || body.content);
  if (prompt === "") throw new HttpError(400, "prompt is required");
  const conversation = requireConversation(context.database, id);
  if (activePiRuns.has(conversation.id)) throw new HttpError(409, "PI conversation is already running");
  const runtime = await openConversationRuntime(context.database, conversation);
  const unsubscribe = runtime.session.subscribe((event) => publishPiSessionEvent(context.bus, conversation, event));
  activePiRuns.set(conversation.id, runtime.session);
  try {
    await runtime.session.prompt(prompt, { expandPromptTemplates: false, source: "rpc" });
    persistPiSessionIndex(context.database, conversation, requireConversationProject(context.database, conversation));
    return {
      conversation_id: conversation.id,
      pi_session_id: runtime.session.sessionId,
      session_file: runtime.session.sessionFile ?? "",
      status: runtime.session.state.errorMessage ? "failed" : "completed",
      text: runtime.session.getLastAssistantText() ?? "",
      message_count: runtime.session.state.messages.length
    };
  } finally {
    if (activePiRuns.get(conversation.id) === runtime.session) activePiRuns.delete(conversation.id);
    unsubscribe();
    runtime.session.dispose();
  }
}

async function interruptPiConversation(context: PiConversationContext, id: string) {
  const active = activePiRuns.get(id);
  if (!active) return { interrupted: false };
  await active.abort();
  return { interrupted: true, conversation_id: id, pi_session_id: active.sessionId };
}

function persistPiSessionIndex(
  db: RunnerDatabase,
  conversation: PiConversation,
  project: Project
): void {
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

async function openConversationRuntime(db: RunnerDatabase, conversation: PiConversation) {
  const project = requireConversationProject(db, conversation);
  const agent = requireConversationAgent(db, conversation);
  return createPiRuntimeSession(db, {
    agent,
    conversationID: conversation.id,
    project,
    sessionFile: conversation.session_file
  });
}

function conversationProject(db: RunnerDatabase, id: string): Project {
  if (id === "") throw new HttpError(400, "project_id is required");
  const project = getProject(db, id);
  if (!project) throw new HttpError(404, "资源不存在");
  return project;
}

function conversationAgent(db: RunnerDatabase, id: string): PiAgent {
  const agentID = id || (listPiAgents(db).find((agent) => agent.enabled === 1)?.id ?? "");
  if (agentID === "") throw new HttpError(400, "PI agent 不存在");
  const agent = getPiAgent(db, agentID);
  if (!agent) throw new HttpError(400, "PI agent 不存在");
  if (agent.enabled !== 1) throw new HttpError(400, "disabled PI agent cannot start conversation");
  return agent;
}

function requireConversation(db: RunnerDatabase, id: string): PiConversation {
  const conversation = getPiConversation(db, id);
  if (!conversation) throw new HttpError(404, "资源不存在");
  return conversation;
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

async function parseObjectBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await parseJsonBody(request);
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch (error) {
    if (error instanceof HttpError) throw new HttpError(400, "请求体不是合法 JSON");
    throw error;
  }
}

function pathPart(request: Request, marker: string): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const value = parts[parts.indexOf(marker) + 1]?.trim() ?? "";
  if (value === "") throw new HttpError(400, `${marker} id 不能为空`);
  return decodeURIComponent(value);
}

function requireConversationProject(db: RunnerDatabase, conversation: PiConversation): Project {
  const project = getProject(db, conversation.project_id);
  if (!project) throw new HttpError(404, "资源不存在");
  return project;
}

function requireConversationAgent(db: RunnerDatabase, conversation: PiConversation): PiAgent {
  const agent = getPiAgent(db, conversation.pi_agent_id);
  if (!agent) throw new HttpError(400, "PI agent 不存在");
  if (agent.enabled !== 1) throw new HttpError(400, "disabled PI agent cannot start conversation");
  return agent;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
