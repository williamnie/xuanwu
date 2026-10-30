import { PI_MANAGER_ROLE } from "../../agents/roles.ts";
import type { RunnerDatabase } from "../../db/database.ts";
import { ensureDefaultPiAgent } from "../../db/defaultPiAgent.ts";
import { upsertAgentSession } from "../../db/repositories/agentSessions.ts";
import { createPiConversation, getPiAgent, getPiConversation, getPiPersona, getPiSupervisor, listPiConversations, type PiAgent, type PiConversation } from "../../db/repositories/pi.ts";
import { getProject, type Project } from "../../db/repositories/projects.ts";
import { HttpError, json, parseJsonBody } from "../errors.ts";
import { piConversationDetail } from "./piConversationTranscript.ts";
import type { PiRuntimeResult } from "./piRuntime.ts";
import { appLanguage, inferAppLanguageFromText, parseAppLanguage, type AppLanguage } from "../../i18n/language.ts";
import { cleanString } from "../../util/values.ts";
import { comparePiConversationActivity, piConversationRuntimeState, piConversationRuntimeView } from "./piConversationView.ts";
import type { PiConversationContext } from "./piConversationApi.model.ts";

export const PI_SESSION_PROVIDER = "pi-sdk";

export function piConversationListResponse(context: PiConversationContext, request: Request): Response {
  const params = new URL(request.url).searchParams;
  const conversations = listPiConversations(context.database, {
    includeInternal: params.get("include_internal") === "1",
    projectId: cleanString(params.get("project_id")),
    status: cleanString(params.get("status"))
  }).map(piConversationRuntimeView).sort(comparePiConversationActivity);
  return json(conversations);
}

export async function piConversationCreateResponse(context: PiConversationContext, request: Request): Promise<Response> {
  const body = await parseObjectBody(request);
  return writeResponse(async () => createConversationWithRuntime(context, body), 201);
}

export async function piConversationResponse(context: PiConversationContext, request: Request): Promise<Response> {
  const conversation = getPiConversation(context.database, pathPart(request, "conversations"));
  if (!conversation) throw new HttpError(404, "资源不存在");
  // 转录读取会让出事件循环；保留请求开始时的运行态，避免流中快照被终态覆盖。
  const runtimeState = piConversationRuntimeState(conversation);
  return json({
    ...await piConversationDetail(conversation),
    ...runtimeState
  });
}

export async function createConversationWithRuntime(
  context: PiConversationContext,
  body: Record<string, unknown>
): Promise<PiConversation> {
  const { createOrRestorePiRuntime } = await import("./piRuntime.ts");
  const project = optionalConversationProject(context.database, cleanString(body.project_id));
  const agent = conversationAgent(context.database);
  const id = cleanString(body.id) || crypto.randomUUID();
  const runtime = await createOrRestorePiRuntime(context.database, {
    agent,
    bus: context.bus,
    conversationID: id,
    promptProfile: "chat",
    project
  });
  const conversation = createPiConversation(context.database, conversationInput({
    body,
    id,
    piAgentID: agent.id,
    projectID: project?.id ?? "",
    runtime
  }));
  persistPiSessionIndex(context.database, conversation);
  return conversation;
}

export function conversationInput(input: {
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

export function positiveInteger(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

export function persistPiSessionIndex(
  db: RunnerDatabase,
  conversation: PiConversation
): void {
  upsertAgentSession(db, {
    provider: PI_SESSION_PROVIDER,
    provider_session_id: conversation.pi_session_id,
    agent_role: PI_MANAGER_ROLE,
    project_id: conversation.project_id,
    title: conversation.title,
    preview: "",
    status: conversation.status,
    raw_ref: { conversation_id: conversation.id, session_file: conversation.session_file }
  });
}

export function conversationOutputLanguage(
  db: RunnerDatabase,
  requested: unknown,
  userPrompt: string
): AppLanguage | undefined {
  const explicit = cleanString(requested);
  if (explicit !== "") return parseAppLanguage(explicit);
  const persona = getPiPersona(db);
  if (persona?.enabled !== 1 || persona.language_mode !== "follow_user") return undefined;
  return inferAppLanguageFromText(userPrompt, appLanguage(db));
}

export function optionalConversationProject(db: RunnerDatabase, id: string): Project | undefined {
  if (id === "") return undefined;
  const project = getProject(db, id);
  if (!project) throw new HttpError(404, "资源不存在");
  return project;
}

export function conversationAgent(db: RunnerDatabase): PiAgent {
  ensureDefaultPiAgent(db);
  const agent = getPiSupervisor(db);
  if (!agent) throw new HttpError(500, "Supervisor 配置不可用");
  if (agent.enabled !== 1) throw new HttpError(400, "disabled Supervisor cannot start conversation");
  return agent;
}

export function requireConversation(db: RunnerDatabase, id: string): PiConversation {
  const conversation = getPiConversation(db, id);
  if (!conversation) throw new HttpError(404, "资源不存在");
  return conversation;
}

export async function writeResponse(write: () => unknown | Promise<unknown>, status = 200): Promise<Response> {
  try {
    return json(await write(), { status });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error) throw new HttpError(400, error.message);
    throw error;
  }
}

export async function parseObjectBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await parseJsonBody(request);
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch (error) {
    if (error instanceof HttpError) throw new HttpError(400, "请求体不是合法 JSON");
    throw error;
  }
}

export function pathPart(request: Request, marker: string): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const value = parts[parts.indexOf(marker) + 1]?.trim() ?? "";
  if (value === "") throw new HttpError(400, `${marker} id 不能为空`);
  return decodeURIComponent(value);
}

export function requireConversationProject(db: RunnerDatabase, conversation: PiConversation): Project {
  const project = getProject(db, conversation.project_id);
  if (!project) throw new HttpError(404, "资源不存在");
  return project;
}

export function requireConversationAgent(db: RunnerDatabase, conversation: PiConversation): PiAgent {
  const agent = getPiAgent(db, conversation.pi_agent_id);
  if (!agent) throw new HttpError(400, "Conversation Supervisor 不存在");
  if (agent.enabled !== 1) throw new HttpError(400, "disabled Supervisor cannot start conversation");
  return agent;
}

export function oneShotProjectSource(value: unknown, fallback: string): string {
  const source = cleanString(value);
  return ["card_select", "explicit_project", "issue_ref", "mapping_default", "request_project"]
    .includes(source) ? source : fallback;
}
