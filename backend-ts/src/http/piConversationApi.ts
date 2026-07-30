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
import { piTurnSessionEvent, publishPiSessionEvent, type PiTurnSessionEvent } from "./piSessionEvents.ts";
import { PI_READ_ONLY_ACTION_TYPES } from "../pi/actionGate.ts";
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
const PI_TURN_HEARTBEAT_MS = 15_000;
type ActivePiRun = {
  session: PiRuntimeSession["session"];
  startedAt: string;
  text: string;
  turnID: string;
  updatedAt: string;
};
const activePiRuns = new Map<string, ActivePiRun>();

type PiConversationTurn = {
  conversation: PiConversation;
  prompt: string;
  runtime: PiRuntimeSession;
  turnID: string;
};

type PiConversationTurnResult = {
  conversation_id: string;
  message_count: number;
  pi_session_id: string;
  session_file: string;
  status: "completed" | "failed";
  text: string;
  title: string;
  turn_id: string;
};

export function registerPiConversationRoutes(router: Router, context: PiConversationContext): void {
  router.get("/api/pi/conversations", (request) => piConversationListResponse(context, request));
  router.post("/api/pi/conversations", async (request) => piConversationCreateResponse(context, request));
  router.get("/api/pi/conversations/:id", (request) => piConversationResponse(context, request));
  router.post("/api/pi/conversations/:id/messages", async (request) => piConversationMessageResponse(context, request));
  router.post("/api/pi/conversations/:id/interrupt", (request) => piConversationInterruptResponse(context, request));
}

function piConversationListResponse(context: PiConversationContext, request: Request): Response {
  const params = new URL(request.url).searchParams;
  const conversations = listPiConversations(context.database, {
    includeInternal: params.get("include_internal") === "1",
    projectId: cleanString(params.get("project_id")),
    status: cleanString(params.get("status"))
  }).map(piConversationRuntimeView).sort(comparePiConversationActivity);
  return json(conversations);
}

async function piConversationCreateResponse(context: PiConversationContext, request: Request): Promise<Response> {
  const body = await parseObjectBody(request);
  return writeResponse(async () => createConversationWithRuntime(context, body), 201);
}

function piConversationResponse(context: PiConversationContext, request: Request): Response {
  const conversation = getPiConversation(context.database, pathPart(request, "conversations"));
  if (!conversation) throw new HttpError(404, "资源不存在");
  return json({
    ...piConversationDetail(conversation),
    ...piConversationRuntimeState(conversation)
  });
}

async function piConversationMessageResponse(context: PiConversationContext, request: Request): Promise<Response> {
  const body = await parseObjectBody(request);
  const id = pathPart(request, "conversations");
  try {
    const turn = await preparePiConversationTurn(context, id, body);
    return piConversationTurnStreamResponse(context, turn);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error) throw new HttpError(400, error.message);
    throw error;
  }
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
): Promise<PiConversationTurnResult> {
  const turn = await preparePiConversationTurn(context, id, body, trusted);
  return executePiConversationTurn(context, turn);
}

async function preparePiConversationTurn(
  context: PiConversationContext,
  id: string,
  body: Record<string, unknown>,
  trusted: { channelContext?: string; targetIssueId?: number } = {}
): Promise<PiConversationTurn> {
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
    supervisorContext,
    intent,
    prompt,
    turnID,
    resolvedSource,
    cleanString(trusted.channelContext)
  );
  let activeConversation: PiConversation;
  try {
    activeConversation = touchPiConversation(context.database, titledConversation);
  } catch (error) {
    runtime.dispose();
    throw error;
  }
  const startedAt = activeConversation.updated_at || new Date().toISOString();
  activePiRuns.set(conversation.id, {
    session: runtime.session,
    startedAt,
    text: "",
    turnID,
    updatedAt: startedAt
  });
  return { conversation: activeConversation, prompt, runtime, turnID };
}

async function executePiConversationTurn(
  context: PiConversationContext,
  turn: PiConversationTurn,
  onEvent?: (event: PiTurnSessionEvent) => void
): Promise<PiConversationTurnResult> {
  const { conversation, prompt, runtime } = turn;
  let unsubscribe = () => {};
  try {
    unsubscribe = runtime.session.subscribe((event) => {
      const streamEvent = piTurnSessionEvent(event);
      recordActivePiTurnEvent(conversation.id, streamEvent);
      publishPiSessionEvent(context.bus, conversation, event, turn.turnID);
      if (streamEvent) onEvent?.(streamEvent);
    });
    await runtime.session.prompt(prompt, {
      expandPromptTemplates: false,
      images: piConversationPromptImages(context.database, prompt),
      source: "rpc"
    });
    return piConversationTurnResult(turn);
  } finally {
    try {
      const latestConversation = getPiConversation(context.database, conversation.id) ?? conversation;
      persistPiSessionIndex(context.database, touchPiConversation(context.database, latestConversation));
    } finally {
      if (activePiRuns.get(conversation.id)?.session === runtime.session) activePiRuns.delete(conversation.id);
      try {
        unsubscribe();
      } finally {
        runtime.dispose();
      }
    }
  }
}

function piConversationTurnResult(turn: PiConversationTurn): PiConversationTurnResult {
  const { conversation, runtime, turnID } = turn;
  return {
    conversation_id: conversation.id,
    pi_session_id: runtime.session.sessionId,
    session_file: runtime.session.sessionFile ?? "",
    status: runtime.session.state.errorMessage ? "failed" : "completed",
    title: conversation.title,
    text: piConversationResultText(runtime.session),
    message_count: runtime.session.state.messages.length,
    turn_id: turnID
  };
}

function piConversationTurnStreamResponse(
  context: PiConversationContext,
  turn: PiConversationTurn
): Response {
  const encoder = new TextEncoder();
  let connected = true;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      enqueuePiTurnEvent("accepted", piTurnEventBase(turn, { status: "accepted" }));
      heartbeat = setInterval(() => enqueueComment("heartbeat"), PI_TURN_HEARTBEAT_MS);
      void executePiConversationTurn(context, turn, (event) => {
        if (event.type === "start") {
          enqueuePiTurnEvent("start", piTurnEventBase(turn, { status: "running" }));
          return;
        }
        enqueuePiTurnEvent("assistant_text_delta", piTurnEventBase(turn, {
          delta: event.delta,
          text: event.delta
        }));
      }).then((result) => {
        if (result.status === "completed") {
          enqueuePiTurnEvent("completed", result);
        } else {
          enqueuePiTurnEvent("failed", {
            ...result,
            error: piConversationTurnError(turn.runtime.session)
          });
        }
      }).catch((error) => {
        enqueuePiTurnEvent("failed", {
          ...piConversationTurnResult(turn),
          error: {
            code: "runtime_error",
            message: redactSensitiveText(error instanceof Error ? error.message : String(error))
          },
          status: "failed"
        });
      }).finally(() => close());
    },
    cancel() {
      connected = false;
      clearHeartbeat();
    }
  });

  function enqueuePiTurnEvent(event: string, data: Record<string, unknown>): void {
    enqueue(`id: ${turn.turnID}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function enqueueComment(comment: string): void {
    enqueue(`: ${comment}\n\n`);
  }

  function enqueue(value: string): void {
    if (!connected) return;
    try {
      controller.enqueue(encoder.encode(value));
    } catch {
      connected = false;
      clearHeartbeat();
    }
  }

  function close(): void {
    clearHeartbeat();
    if (!connected) return;
    connected = false;
    try {
      controller.close();
    } catch {
      // The client may have disconnected after the final event was produced.
    }
  }

  function clearHeartbeat(): void {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
  }

  return new Response(stream, {
    status: 201,
    headers: {
      "cache-control": "no-cache, no-transform",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no"
    }
  });
}

function piTurnEventBase(
  turn: PiConversationTurn,
  extra: Record<string, unknown>
): Record<string, unknown> {
  return {
    conversation_id: turn.conversation.id,
    pi_session_id: turn.runtime.session.sessionId,
    turn_id: turn.turnID,
    ...extra
  };
}

function piConversationTurnError(session: AgentSession): { code: string; message: string } {
  const message = session.state.errorMessage || lastAssistantErrorMessage(session);
  return {
    code: message === "Request was aborted" ? "interrupted" : "provider_error",
    message: redactSensitiveText(message)
  };
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
  await active.session.abort();
  return { interrupted: true, conversation_id: id, pi_session_id: active.session.sessionId };
}

function piConversationRuntimeView(conversation: PiConversation) {
  const active = activePiRuns.get(conversation.id);
  return {
    ...conversation,
    active_turn_id: active?.turnID ?? "",
    last_activity_at: active?.updatedAt || conversation.updated_at,
    runtime_status: active ? "running" as const : "idle" as const,
    turn_started_at: active?.startedAt ?? ""
  };
}

function piConversationRuntimeState(conversation: PiConversation) {
  const active = activePiRuns.get(conversation.id);
  return {
    active_text: active?.text ?? "",
    active_turn_id: active?.turnID ?? "",
    last_activity_at: active?.updatedAt || conversation.updated_at,
    runtime_status: active ? "running" as const : "idle" as const,
    turn_started_at: active?.startedAt ?? ""
  };
}

function comparePiConversationActivity(
  left: ReturnType<typeof piConversationRuntimeView>,
  right: ReturnType<typeof piConversationRuntimeView>
): number {
  if (left.runtime_status !== right.runtime_status) return left.runtime_status === "running" ? -1 : 1;
  return right.last_activity_at.localeCompare(left.last_activity_at) || left.id.localeCompare(right.id);
}

function recordActivePiTurnEvent(conversationID: string, event: PiTurnSessionEvent | undefined): void {
  const active = activePiRuns.get(conversationID);
  if (!active || !event) return;
  if (event.type === "assistant_text_delta") active.text += event.delta;
  active.updatedAt = new Date().toISOString();
}

function touchPiConversation(db: RunnerDatabase, conversation: PiConversation): PiConversation {
  return updatePiConversation(db, conversation.id, { status: conversation.status });
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
    authorization: conversationAuthorization(review, toolProject, PI_RUNNER_CHAT_ACTIONS),
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
  });
}

function conversationAuthorization(
  review: boolean,
  project: Project | undefined,
  runnerChatActions: readonly string[]
) {
  if (review) return reviewConversationAuthorization();
  if (project) return runnerChatAuthorization(project, runnerChatActions);
  return unboundRunnerChatAuthorization();
}

function runnerChatAuthorization(
  project: Project,
  runnerChatActions: readonly string[]
) {
  const actions = [...runnerChatActions];
  return {
    allowedActions: actions,
    allowedMcpCapabilities: parseMcpPolicy(project.default_mcp_policy).allowed,
    authorizedActions: runnerChatAuthorizedActions(actions),
    mode: "delegated" as const,
    scopes: [{ runner_resource: "issues" }, { project_id: project.id }]
  };
}

function unboundRunnerChatAuthorization() {
  const actions = [
    ...PI_READ_ONLY_ACTION_TYPES,
    "project.create",
    "workspace.make_directory",
    "workspace.write_file"
  ];
  return {
    allowedActions: actions,
    authorizedActions: runnerChatAuthorizedActions(actions),
    mode: "delegated" as const,
    scopes: [{ runner_resource: "projects" }, { runner_resource: "workspace" }]
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
