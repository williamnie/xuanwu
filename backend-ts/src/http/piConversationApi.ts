import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { PI_MANAGER_ROLE } from "../agents/roles.ts";
import type { RunnerConfig } from "../config/env.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { ensureDefaultPiAgent } from "../db/defaultPiAgent.ts";
import { parseMcpPolicy } from "../mcp/policy.ts";
import { upsertAgentSession } from "../db/repositories/agentSessions.ts";
import {
  createPiConversation,
  getPiAgent,
  getPiConversation,
  getPiSupervisor,
  listPiConversations,
  updatePiConversation,
  type PiAgent,
  type PiConversation
} from "../db/repositories/pi.ts";
import { getProject, type Project } from "../db/repositories/projects.ts";
import type { EventBus } from "../events/bus.ts";
import { startProjectLoop } from "../runner/projectLoopManager.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import { piConversationPromptImages } from "./piConversationImages.ts";
import { piConversationDetail } from "./piConversationTranscript.ts";
import type { PiRuntimeResult, PiRuntimeSession } from "./piRuntime.ts";
import { publishPiSessionEvent } from "./piSessionEvents.ts";
import { PI_READ_ONLY_ACTION_TYPES } from "../pi/actionGate.ts";
import {
  recordSupervisorIntentRouteAudit,
  routeSupervisorIntent,
  supervisorIntentRouteAllowsMutation,
  type SupervisorIntentRoute
} from "../pi/supervisorIntentRouter.ts";
import {
  recordSupervisorContextResolutionAudit,
  resolveSupervisorContext,
  type SupervisorContextResolution
} from "../pi/supervisorContextResolver.ts";
import { linkSupervisorCommitmentsForConversation } from "../pi/supervisorCommitments.ts";
import {
  isReviewConversationIntent,
  reviewConversationAuthorization,
  reviewConversationSource
} from "./piConversationReview.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import type { Router } from "./router.ts";

type PiConversationContext = {
  bus?: EventBus;
  config?: RunnerConfig;
  database: RunnerDatabase;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};
export type PiConversationPromptInput = {
  channelContext?: string;
  clearProjectId?: boolean;
  conversationId?: string;
  intent?: string;
  projectId?: string;
  prompt: string;
  targetProjectId?: string;
  targetProjectSource?: string;
  targetIssueId?: number;
  title?: string;
};

const PI_SESSION_PROVIDER = "pi-sdk";
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
  return json(piConversationDetail(conversation));
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
  const { createOrRestorePiRuntime } = await import("./piRuntime.ts");
  const project = optionalConversationProject(context.database, cleanString(body.project_id));
  const agent = conversationAgent(context.database);
  const id = cleanString(body.id) || crypto.randomUUID();
  const runtime = await createOrRestorePiRuntime(context.database, {
    agent,
    bus: context.bus,
    conversationID: id,
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
  body: Record<string, unknown>,
  trusted: { channelContext?: string; targetIssueId?: number } = {}
) {
  const prompt = cleanString(body.prompt || body.message || body.content);
  if (prompt === "") throw new HttpError(400, "prompt is required");
  const intent = cleanString(body.intent);
  const targetProjectId = cleanString(body.target_project_id ?? body.targetProjectId);
  const targetIssueId = positiveInteger(trusted.targetIssueId);
  const conversation = requireConversation(context.database, id);
  if (activePiRuns.has(conversation.id)) throw new HttpError(409, "PI conversation is already running");
  const titledConversation = ensureConversationTitle(context.database, conversation, prompt);
  const review = isReviewConversationIntent(intent);
  const source = review ? reviewConversationSource(titledConversation) : runnerChatSource(titledConversation);
  const resolvedSource = source ?? (review ? "runner_review" : "runner_chat");
  const turnID = crypto.randomUUID();
  const intentRoute = routeSupervisorIntent({
    intentHint: intent,
    prompt,
    source: resolvedSource
  });
  if (targetProjectId !== "") optionalConversationProject(context.database, targetProjectId);
  const supervisorContext = resolveSupervisorContext(context.database, {
    conversationID: titledConversation.id,
    conversationProjectID: titledConversation.project_id,
    oneShotProjectID: targetProjectId,
    oneShotIssueID: targetIssueId,
    oneShotSource: oneShotProjectSource(body.target_project_source ?? body.targetProjectSource, resolvedSource),
    prompt,
    source: resolvedSource
  });
  recordSupervisorIntentRouteAudit(context.database, {
    conversationID: titledConversation.id,
    projectID: supervisorContext.target.project_id,
    turnID
  }, intentRoute);
  recordSupervisorContextResolutionAudit(context.database, {
    conversationID: titledConversation.id,
    turnID
  }, supervisorContext);
  linkSupervisorCommitmentsForConversation(context.database, {
    conversationID: titledConversation.id,
    projectID: supervisorContext.target.project_id,
    workIDs: supervisorContext.target.work_ids
  });
  const runtime = await openConversationRuntime(
    context,
    titledConversation,
    intentRoute,
    supervisorContext,
    intent,
    prompt,
    turnID,
    resolvedSource,
    cleanString(trusted.channelContext)
  );
  const unsubscribe = runtime.session.subscribe((event) => publishPiSessionEvent(context.bus, conversation, event));
  activePiRuns.set(conversation.id, runtime.session);
  try {
    await runtime.session.prompt(prompt, {
      expandPromptTemplates: false,
      images: piConversationPromptImages(context.database, prompt),
      source: "rpc"
    });
    persistPiSessionIndex(context.database, titledConversation);
    return {
      conversation_id: titledConversation.id,
      pi_session_id: runtime.session.sessionId,
      session_file: runtime.session.sessionFile ?? "",
      status: runtime.session.state.errorMessage ? "failed" : "completed",
      title: titledConversation.title,
      text: piConversationResultText(runtime.session),
      message_count: runtime.session.state.messages.length
    };
  } finally {
    if (activePiRuns.get(conversation.id) === runtime.session) activePiRuns.delete(conversation.id);
    unsubscribe();
    runtime.dispose();
  }
}

export async function runPiConversationPrompt(
  context: PiConversationContext,
  input: PiConversationPromptInput
) {
  const id = cleanString(input.conversationId) || crypto.randomUUID();
  const projectID = cleanString(input.projectId);
  const existing = getPiConversation(context.database, id);
  if (!existing) {
    await createConversationWithRuntime(context, {
      id,
      project_id: projectID,
      title: cleanString(input.title) || "Feishu"
    });
  } else if (input.clearProjectId && projectID === "" && existing.project_id !== "") {
    await resetConversationProjectRuntime(context, existing);
  } else if (projectID !== "" && existing.project_id !== projectID) {
    optionalConversationProject(context.database, projectID);
    updatePiConversation(context.database, existing.id, { project_id: projectID });
  }
  return sendPiConversationMessage(context, id, {
    intent: input.intent,
    prompt: input.prompt,
    target_project_id: input.targetProjectId || projectID,
    target_project_source: input.targetProjectSource || (projectID === "" ? undefined : "request_project")
  }, {
    channelContext: input.channelContext,
    targetIssueId: input.targetIssueId
  });
}

async function resetConversationProjectRuntime(
  context: PiConversationContext,
  conversation: PiConversation
): Promise<PiConversation> {
  const { createOrRestorePiRuntime } = await import("./piRuntime.ts");
  const runtime = await createOrRestorePiRuntime(context.database, {
    agent: requireConversationAgent(context.database, conversation),
    bus: context.bus,
    conversationID: conversation.id
  });
  const reset = updatePiConversation(context.database, conversation.id, {
    pi_session_id: runtime.piSessionId,
    project_id: "",
    session_file: runtime.sessionFile
  });
  persistPiSessionIndex(context.database, reset);
  clearPiSessionProjectIndex(context.database, reset.pi_session_id);
  return reset;
}

function ensureConversationTitle(
  db: RunnerDatabase,
  conversation: PiConversation,
  prompt: string
): PiConversation {
  if (!shouldReplaceConversationTitle(conversation.title)) return conversation;
  const title = deriveConversationTitle(prompt);
  if (title === "" || title === conversation.title) return conversation;
  return updatePiConversation(db, conversation.id, { title });
}

function shouldReplaceConversationTitle(title: string): boolean {
  const text = cleanString(title);
  return text === "" || text === "Runner" || text === "New conversation" || /^Runner\s*·/.test(text);
}

function deriveConversationTitle(prompt: string): string {
  const text = cleanString(prompt)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/[*_~>#-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return truncateTitle(text);
}

function truncateTitle(text: string): string {
  const limit = 48;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function positiveInteger(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

async function interruptPiConversation(context: PiConversationContext, id: string) {
  const active = activePiRuns.get(id);
  if (!active) return { interrupted: false };
  await active.abort();
  return { interrupted: true, conversation_id: id, pi_session_id: active.sessionId };
}

function piConversationResultText(session: AgentSession): string {
  const text = session.getLastAssistantText();
  if (text) return text;
  const error = session.state.errorMessage || lastAssistantErrorMessage(session);
  if (error === "Request was aborted") return "";
  return error ? `Runner 执行失败：${redactSensitiveText(error)}` : "";
}

function lastAssistantErrorMessage(session: AgentSession): string {
  const messages = session.state.messages.slice().reverse();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const error = message.errorMessage?.trim();
    if (error) return error;
  }
  return "";
}

function persistPiSessionIndex(
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

function clearPiSessionProjectIndex(db: RunnerDatabase, providerSessionID: string): void {
  const sessionID = cleanString(providerSessionID);
  if (sessionID === "") return;
  db.sqlite.run(
    "update agent_sessions set project_id='' where provider=? and provider_session_id=?",
    [PI_SESSION_PROVIDER, sessionID]
  );
}

async function openConversationRuntime(
  context: PiConversationContext,
  conversation: PiConversation,
  intentRoute: SupervisorIntentRoute,
  supervisorContext: SupervisorContextResolution,
  intent = "",
  userPrompt = "",
  turnID = "",
  source?: string,
  channelContext = ""
) {
  const { createPiRuntimeSession, PI_RUNNER_CHAT_ACTIONS } = await import("./piRuntime.ts");
  const project = conversation.project_id === "" || (
    !supervisorContext.provenance.context_inheritance_allowed &&
    supervisorContext.target.project_id !== conversation.project_id
  )
    ? undefined
    : requireConversationProject(context.database, conversation);
  const toolProject = optionalConversationProject(
    context.database,
    supervisorContext.target.project_id
  );
  const agent = requireConversationAgent(context.database, conversation);
  const review = isReviewConversationIntent(intent);
  return createPiRuntimeSession(context.database, {
    agent,
    authorization: conversationAuthorization(review, toolProject, intentRoute, supervisorContext, PI_RUNNER_CHAT_ACTIONS),
    bus: context.bus,
    cliConnectorDirs: context.config?.cliConnectors.manifestDirs,
    channelContext,
    conversationID: conversation.id,
    onIssueEnqueued: (projectID) => startProjectLoop({
      bus: context.bus,
      database: context.database,
      providers: context.providers
    }, projectID, { forceOnce: true }),
    project,
    providers: context.providers,
    sessionFile: conversation.session_file,
    toolProject,
    source,
    sourceTurn: { id: turnID, source, userPrompt },
    supervisorContext,
    supervisorIntentRoute: intentRoute
  });
}

function conversationAuthorization(
  review: boolean,
  project: Project | undefined,
  intentRoute: SupervisorIntentRoute,
  supervisorContext: SupervisorContextResolution,
  runnerChatActions: readonly string[]
) {
  if (review) return reviewConversationAuthorization();
  if (project) return runnerChatAuthorization(project, intentRoute, runnerChatActions);
  if (supervisorContext.status === "ambiguous") return readOnlyConversationAuthorization();
  if (!supervisorIntentRouteAllowsMutation(intentRoute)) return readOnlyConversationAuthorization();
  return undefined;
}

function runnerChatAuthorization(
  project: Project,
  intentRoute: SupervisorIntentRoute,
  runnerChatActions: readonly string[]
) {
  const actions = supervisorIntentRouteAllowsMutation(intentRoute)
    ? [...runnerChatActions]
    : [...PI_READ_ONLY_ACTION_TYPES];
  return {
    allowedActions: actions,
    allowedMcpCapabilities: parseMcpPolicy(project.default_mcp_policy).allowed,
    authorizedActions: runnerChatAuthorizedActions(actions),
    mode: "delegated" as const,
    scopes: [{ runner_resource: "issues" }, { project_id: project.id }]
  };
}

function readOnlyConversationAuthorization() {
  return {
    allowedActions: [...PI_READ_ONLY_ACTION_TYPES],
    authorizedActions: runnerChatAuthorizedActions(PI_READ_ONLY_ACTION_TYPES),
    mode: "attended" as const
  };
}

function runnerChatAuthorizedActions(actions: readonly string[]) {
  return actions.map((action_type) => ({ action_type }));
}

function runnerChatSource(conversation: PiConversation): string | undefined {
  return conversation.id.startsWith("feishu-") ? "feishu_runner_chat" : "runner_chat";
}

function optionalConversationProject(db: RunnerDatabase, id: string): Project | undefined {
  if (id === "") return undefined;
  const project = getProject(db, id);
  if (!project) throw new HttpError(404, "资源不存在");
  return project;
}

function conversationAgent(db: RunnerDatabase): PiAgent {
  ensureDefaultPiAgent(db);
  const agent = getPiSupervisor(db);
  if (!agent) throw new HttpError(500, "Supervisor 配置不可用");
  if (agent.enabled !== 1) throw new HttpError(400, "disabled Supervisor cannot start conversation");
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
  if (!agent) throw new HttpError(400, "Conversation Supervisor 不存在");
  if (agent.enabled !== 1) throw new HttpError(400, "disabled Supervisor cannot start conversation");
  return agent;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function oneShotProjectSource(value: unknown, fallback: string): string {
  const source = cleanString(value);
  return ["card_select", "explicit_project", "issue_ref", "mapping_default", "request_project"]
    .includes(source) ? source : fallback;
}
