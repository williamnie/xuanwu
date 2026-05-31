import type { RunnerDatabase } from "../db/database.ts";
import { getAgentSession, upsertAgentSession } from "../db/repositories/agentSessions.ts";
import { getProject, ProjectNotFoundError, type Project } from "../db/repositories/projects.ts";
import { lastSessionProject } from "../db/repositories/preferences.ts";
import { interruptSession } from "../runner/interrupt.ts";
import type { EventBus } from "../events/bus.ts";
import type { ExecutorProvider, ExecutorProviderId, SessionCreateInput, SessionMessageInput } from "../providers/types.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

export type SessionApiContext = {
  bus?: EventBus;
  database: RunnerDatabase;
  interruptTimeoutMs?: number;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};

export function registerSessionRoutes(router: Router, context: SessionApiContext): void {
  router.get("/api/sessions", (request) => asyncResponse(() => listSessions(context, request)));
  router.post("/api/sessions", async (request) => {
    const body = await parseObjectBody(request);
    return asyncResponse(() => createSession(context, body), 201);
  });
  router.get("/api/sessions/preferences", () => json({ last_project_id: lastSessionProject(context.database) }));
  router.get("/api/sessions/:id", (request) => asyncResponse(() => readSession(context, sessionID(request))));
  router.post("/api/sessions/:id/messages", async (request) => {
    const body = await parseObjectBody(request);
    return asyncResponse(() => sessionMessage(context, sessionID(request), body), 201);
  });
  router.post("/api/sessions/:id/interrupt", (request) => asyncResponse(() => interruptSession(context.database, sessionID(request), {
    bus: context.bus,
    interruptTimeoutMs: context.interruptTimeoutMs,
    providers: context.providers
  })));
}

async function listSessions(context: SessionApiContext, request: Request) {
  const result = await codexProvider(context).listSessions?.(sessionListInput(request));
  if (!result) throw new Error('provider "codex" 不支持 capability "sessions"');
  return result;
}

async function createSession(context: SessionApiContext, body: Record<string, unknown>) {
  const result = await codexProvider(context).createSession?.(sessionCreateInput(context, body));
  if (!result) throw new Error('provider "codex" 不支持 capability "sessions"');
  persistSessionTurn(context, result.provider_session_id, result.provider_turn_id ?? "");
  return result;
}

async function readSession(context: SessionApiContext, rawSessionID: string) {
  const result = await codexProvider(context).readSession?.(parseSessionID(rawSessionID));
  if (!result) throw new Error('provider "codex" 不支持 capability "resume_session"');
  return result;
}

async function sessionMessage(context: SessionApiContext, rawSessionID: string, body: Record<string, unknown>) {
  const sessionId = parseSessionID(rawSessionID);
  const result = await codexProvider(context).sendSessionMessage?.(sessionMessageInput(context, sessionId, body));
  if (!result) throw new Error('provider "codex" 不支持 capability "resume_session"');
  persistSessionTurn(context, result.provider_session_id, result.turn_id);
  return { thread_id: result.provider_session_id, turn_id: result.turn_id };
}

function codexProvider(context: SessionApiContext): ExecutorProvider {
  const provider = context.providers?.codex;
  if (!provider) throw new Error('provider "codex" 当前 runner 未注册');
  return provider;
}

function sessionListInput(request: Request): { cursor: string; limit: number } {
  const params = new URL(request.url).searchParams;
  return { cursor: cleanParam(params.get("cursor")), limit: sessionLimit(params.get("limit")) };
}

function sessionCreateInput(context: SessionApiContext, body: Record<string, unknown>): SessionCreateInput {
  const project = projectForSession(context, stringBody(body, "project_id"));
  return {
    projectId: project?.id,
    cwd: firstNonEmpty(stringBody(body, "cwd"), project?.cwd ?? ""),
    model: firstNonEmpty(stringBody(body, "model"), project?.model ?? ""),
    reasoningEffort: stringBody(body, "reasoning_effort"),
    approvalPolicy: firstNonEmpty(stringBody(body, "approval_policy"), project?.approval_policy ?? ""),
    sandbox: firstNonEmpty(stringBody(body, "sandbox"), project?.sandbox ?? ""),
    prompt: stringBody(body, "prompt")
  };
}

function sessionMessageInput(context: SessionApiContext, sessionId: string, body: Record<string, unknown>): SessionMessageInput {
  const mode = stringBody(body, "mode");
  return {
    sessionId,
    turnId: mode === "steer" ? latestSessionTurnID(context.database, sessionId) : "",
    prompt: stringBody(body, "prompt"),
    mode,
    model: stringBody(body, "model"),
    reasoningEffort: stringBody(body, "reasoning_effort"),
    approvalPolicy: stringBody(body, "approval_policy"),
    sandbox: stringBody(body, "sandbox")
  };
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

async function asyncResponse(write: () => Promise<unknown>, status = 200): Promise<Response> {
  try {
    return json(await write(), { status });
  } catch (error) {
    if (error instanceof ProjectNotFoundError) throw new HttpError(404, error.message);
    if (error instanceof Error) throw new HttpError(400, error.message);
    throw error;
  }
}

function sessionID(request: Request): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const raw = parts[parts.indexOf("sessions") + 1] ?? "";
  const id = decodeURIComponent(raw).trim();
  if (id === "") throw new HttpError(400, "session id 不能为空");
  return id;
}

function parseSessionID(rawSessionID: string): string {
  const separator = rawSessionID.indexOf(":");
  if (separator < 0) return rawSessionID.trim();
  const provider = rawSessionID.slice(0, separator).trim();
  if (provider !== "codex") throw new Error("session provider 暂不支持");
  return rawSessionID.slice(separator + 1).trim();
}

function projectForSession(context: SessionApiContext, projectId: string): Project | null {
  if (projectId === "") return null;
  const project = getProject(context.database, projectId);
  if (!project) throw new ProjectNotFoundError();
  if (project.provider !== "codex") throw new Error(`provider "${project.provider}" 不支持 capability "sessions"`);
  return project;
}

function persistSessionTurn(context: SessionApiContext, sessionId: string, turnId: string): void {
  if (sessionId === "" || turnId === "") return;
  upsertAgentSession(context.database, {
    provider: "codex",
    provider_session_id: sessionId,
    raw_ref: { provider_turn_id: turnId },
    status: "running"
  });
}

function latestSessionTurnID(db: RunnerDatabase, sessionId: string): string {
  const session = getAgentSession(db, `codex:${sessionId}`);
  if (!session?.raw_ref) return "";
  try {
    const raw = JSON.parse(session.raw_ref) as Record<string, unknown>;
    return typeof raw.provider_turn_id === "string" ? raw.provider_turn_id.trim() : "";
  } catch {
    return "";
  }
}

function sessionLimit(value: string | null): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0) return 50;
  return Math.min(limit, 100);
}

function stringBody(body: Record<string, unknown>, key: string): string {
  return typeof body[key] === "string" ? body[key].trim() : "";
}

function firstNonEmpty(...values: string[]): string {
  return values.find((value) => value.trim() !== "")?.trim() ?? "";
}

function cleanParam(value: string | null): string {
  return value?.trim() ?? "";
}
