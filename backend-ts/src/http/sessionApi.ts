import type { RunnerDatabase } from "../db/database.ts";
import { getAgentSession, listAgentSessions, upsertAgentSession, type AgentSession } from "../db/repositories/agentSessions.ts";
import { getProject, ProjectNotFoundError, type Project } from "../db/repositories/projects.ts";
import { lastSessionProject } from "../db/repositories/preferences.ts";
import { interruptSession } from "../runner/interrupt.ts";
import type { EventBus } from "../events/bus.ts";
import {
  isExecutorProviderId,
  type ExecutorCapability,
  type ExecutorProvider,
  type ExecutorProviderId,
  type SessionCreateInput,
  type SessionMessageInput
} from "../providers/types.ts";
import { runtimeRawRef, runtimeSettingsFromAgentSession, withSessionRuntimeSettings } from "./sessionRuntimeSettings.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";
import { reconcileCodexSessionIndex, reconcileCodexSessionIndexes } from "./sessionIndexReconciler.ts";
import { redactedUserVisibleText } from "../util/redact.ts";

export type SessionApiContext = {
  bus?: EventBus;
  database: RunnerDatabase;
  interruptTimeoutMs?: number;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};

type QualifiedSessionRef = { key: string; provider: string; sessionId: string };

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
  const params = new URL(request.url).searchParams;
  const filter = {
    projectId: cleanParam(params.get("project_id") || params.get("projectId")),
    provider: cleanParam(params.get("provider")),
    role: cleanParam(params.get("role") || params.get("agent_role"))
  };
  const project = filter.projectId ? projectForSession(context, filter.projectId) : null;
  const limit = sessionLimit(params.get("limit"));
  const indexed = listAgentSessions(context.database, { ...filter, limit }).map(publicAgentSession);
  if (filter.role || (filter.provider && !isExecutorProviderId(filter.provider))) {
    return { data: indexed, nextCursor: "" };
  }
  const providers = providersForList(context, filter);
  const merged = new Map(indexed.map((item) => [String(item.id), item]));
  const providerErrors: Array<{ error: string; provider: string }> = [];
  for (const provider of providers) {
    try {
      const runtimeStatus = provider.runtimeStatus?.();
      if (runtimeStatus?.ready === false) {
        throw new Error(`provider "${provider.id}" 尚未就绪: ${runtimeStatus.reason || "configuration required"}`);
      }
      const result = await provider.listSessions!({
        ...sessionListInput(request),
        ...(project ? { cwd: project.cwd } : {})
      });
      if (provider.id === "codex") reconcileCodexSessionIndexes(context.database, result.data);
      for (const raw of result.data) {
        const item = qualifiedProviderSession(provider.id, raw);
        const key = String(item.id);
        const existing = merged.get(key);
        merged.set(key, {
          ...(existing ?? {}),
          ...item,
          // agent_sessions is the provider-neutral lifecycle index. Provider
          // discovery enriches it, but must not downgrade an indexed running
          // session to an idle historical summary.
          ...(provider.id !== "codex" && existing?.status ? { status: existing.status } : {})
        });
      }
    } catch (error) {
      providerErrors.push({ provider: provider.id, error: safeSessionError(error) });
    }
  }
  const data = [...merged.values()]
    .filter((item) => !filter.provider || item.provider === filter.provider)
    .slice(0, limit);
  return { data, nextCursor: "", ...(providerErrors.length > 0 ? { provider_errors: providerErrors } : {}) };
}

async function createSession(context: SessionApiContext, body: Record<string, unknown>) {
  const project = projectForSession(context, stringBody(body, "project_id"));
  const providerID = firstNonEmpty(stringBody(body, "provider"), project?.provider ?? "codex");
  const provider = capableProvider(context, providerID, "sessions", "createSession");
  const input = sessionCreateInput(body, project);
  const result = await provider.createSession!(input);
  assertProviderResult(provider.id, result.provider);
  persistSession(context, provider.id, input, result.provider_session_id, result.provider_turn_id ?? "");
  return { ...result, id: `${provider.id}:${result.provider_session_id}`, provider: provider.id };
}

async function readSession(context: SessionApiContext, rawSessionID: string) {
  const ref = parseSessionRef(rawSessionID);
  const registeredProvider = isExecutorProviderId(ref.provider) ? context.providers?.[ref.provider] : undefined;
  if (!registeredProvider) {
    const indexed = publicAgentSessionOrNull(getAgentSession(context.database, ref.key));
    if (!indexed) throw new Error(`session provider "${ref.provider}" 当前 runner 未注册`);
    return indexed;
  }
  const provider = capableProvider(context, ref.provider, "sessions", "readSession");
  let result: Record<string, unknown>;
  try {
    result = await provider.readSession!(ref.sessionId);
  } catch (error) {
    const fallback = ref.provider === "codex" ? pendingCodexSessionFallback(context.database, ref.sessionId, error) : null;
    if (!fallback) throw error;
    result = fallback;
  }
  if (ref.provider === "codex") reconcileCodexSessionIndex(context.database, ref.sessionId, result);
  return await withSessionRuntimeSettings(
    context.database,
    ref.sessionId,
    qualifiedProviderSession(ref.provider, result),
    ref.provider
  );
}

async function sessionMessage(context: SessionApiContext, rawSessionID: string, body: Record<string, unknown>) {
  const ref = parseSessionRef(rawSessionID);
  if (!isExecutorProviderId(ref.provider)) throw new Error(`provider "${ref.provider}" 不支持 capability "resume_session"`);
  const provider = capableProvider(context, ref.provider, "resume_session", "sendSessionMessage");
  const input = sessionMessageInput(context, ref, body);
  const result = await provider.sendSessionMessage!(input);
  assertProviderResult(provider.id, result.provider);
  persistSessionTurn(context, provider.id, input, result.provider_session_id, result.turn_id);
  return { thread_id: result.provider_session_id, turn_id: result.turn_id };
}

function capableProvider(
  context: SessionApiContext,
  rawProviderID: string,
  capability: ExecutorCapability,
  method: "createSession" | "listSessions" | "readSession" | "sendSessionMessage"
): ExecutorProvider {
  const providerID = rawProviderID.trim();
  if (!isExecutorProviderId(providerID)) throw new Error(`session provider "${providerID}" 当前 runner 未注册`);
  const provider = context.providers?.[providerID];
  if (!provider) throw new Error(`provider "${providerID}" 当前 runner 未注册`);
  if (!provider.capabilities.includes(capability) || typeof provider[method] !== "function") {
    throw new Error(`provider "${providerID}" 不支持 capability "${capability}"`);
  }
  const status = provider.runtimeStatus?.();
  if (status?.ready === false) {
    throw new Error(`provider "${providerID}" 尚未就绪: ${status.reason || "configuration required"}`);
  }
  return provider;
}

function providersForList(context: SessionApiContext, filter: { projectId: string; provider: string }): ExecutorProvider[] {
  const wanted = filter.provider || (filter.projectId ? getProject(context.database, filter.projectId)?.provider ?? "" : "");
  return Object.values(context.providers ?? {}).filter((provider): provider is ExecutorProvider => {
    if (!provider || (wanted && provider.id !== wanted)) return false;
    if (!provider.capabilities.includes("sessions") || typeof provider.listSessions !== "function") return false;
    return wanted !== "" || provider.runtimeStatus?.().ready !== false;
  });
}

function sessionListInput(request: Request): { cursor: string; limit: number } {
  const params = new URL(request.url).searchParams;
  return { cursor: cleanParam(params.get("cursor")), limit: sessionLimit(params.get("limit")) };
}

function sessionCreateInput(body: Record<string, unknown>, project: Project | null): SessionCreateInput {
  return {
    projectId: project?.id,
    cwd: firstNonEmpty(stringBody(body, "cwd"), project?.cwd ?? ""),
    model: firstNonEmpty(stringBody(body, "model"), project?.model ?? ""),
    reasoningEffort: stringBody(body, "reasoning_effort"),
    serviceTier: stringBody(body, "service_tier"),
    approvalPolicy: firstNonEmpty(stringBody(body, "approval_policy"), project?.approval_policy ?? ""),
    sandbox: firstNonEmpty(stringBody(body, "sandbox"), project?.sandbox ?? ""),
    prompt: stringBody(body, "prompt")
  };
}

function sessionMessageInput(context: SessionApiContext, ref: QualifiedSessionRef, body: Record<string, unknown>): SessionMessageInput {
  const mode = stringBody(body, "mode");
  const indexed = getAgentSession(context.database, ref.key);
  const project = indexed?.project_id ? getProject(context.database, indexed.project_id) : null;
  const stored = runtimeSettingsFromAgentSession(context.database, ref.sessionId, ref.provider);
  return {
    projectId: project?.id,
    cwd: project?.cwd ?? "",
    sessionId: ref.sessionId,
    turnId: mode === "steer" ? latestSessionTurnID(context.database, ref) : "",
    prompt: stringBody(body, "prompt"),
    mode,
    model: firstNonEmpty(stringBody(body, "model"), stored.model ?? ""),
    reasoningEffort: firstNonEmpty(stringBody(body, "reasoning_effort"), stored.reasoning_effort ?? ""),
    serviceTier: firstNonEmpty(stringBody(body, "service_tier"), stored.service_tier ?? ""),
    approvalPolicy: firstNonEmpty(stringBody(body, "approval_policy"), stored.approval_policy ?? ""),
    sandbox: firstNonEmpty(stringBody(body, "sandbox"), stored.sandbox ?? "")
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
    if (error instanceof Error) throw new HttpError(400, safeSessionError(error));
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

function parseSessionRef(rawSessionID: string): QualifiedSessionRef {
  const clean = rawSessionID.trim();
  const separator = clean.indexOf(":");
  const provider = separator < 0 ? "codex" : clean.slice(0, separator).trim();
  const sessionId = (separator < 0 ? clean : clean.slice(separator + 1)).trim();
  if (provider === "" || sessionId === "") throw new Error("session ref 无效");
  return { key: `${provider}:${sessionId}`, provider, sessionId };
}

function publicAgentSessionOrNull(session: AgentSession | null): Record<string, unknown> | null {
  return session ? publicAgentSession(session) : null;
}

function publicAgentSession(session: AgentSession): Record<string, unknown> {
  return { ...session, id: session.session_key };
}

function qualifiedProviderSession(provider: string, session: Record<string, unknown>): Record<string, unknown> {
  const providerSessionID = firstNonEmpty(
    stringValue(session.provider_session_id),
    stringValue(session.sessionId),
    stringValue(session.thread_id),
    providerIDFromKey(stringValue(session.id), provider)
  );
  return {
    ...session,
    id: providerSessionID ? `${provider}:${providerSessionID}` : stringValue(session.id),
    provider,
    ...(providerSessionID ? { provider_session_id: providerSessionID } : {})
  };
}

function providerIDFromKey(value: string, provider: string): string {
  return value.startsWith(`${provider}:`) ? value.slice(provider.length + 1).trim() : "";
}

function projectForSession(context: SessionApiContext, projectId: string): Project | null {
  if (projectId === "") return null;
  const project = getProject(context.database, projectId);
  if (!project) throw new ProjectNotFoundError();
  return project;
}

function persistSession(
  context: SessionApiContext,
  provider: ExecutorProviderId,
  input: SessionCreateInput,
  sessionId: string,
  turnId: string
): void {
  if (sessionId === "") return;
  upsertAgentSession(context.database, {
    provider,
    provider_session_id: sessionId,
    project_id: input.projectId ?? "",
    preview: sessionPreview(input.prompt ?? ""),
    raw_ref: runtimeRawRef(input, turnId),
    status: provider === "claude" ? "idle" : input.prompt?.trim() ? "running" : "idle"
  });
}

function persistSessionTurn(
  context: SessionApiContext,
  provider: ExecutorProviderId,
  input: SessionMessageInput,
  sessionId: string,
  turnId: string
): void {
  if (sessionId === "" || turnId === "") return;
  upsertAgentSession(context.database, {
    provider,
    provider_session_id: sessionId,
    project_id: input.projectId ?? "",
    raw_ref: {
      ...runtimeSettingsFromAgentSession(context.database, sessionId, provider),
      ...runtimeRawRef(input, turnId)
    },
    status: provider === "claude" ? "idle" : "running"
  });
}

function latestSessionTurnID(db: RunnerDatabase, ref: QualifiedSessionRef): string {
  const session = getAgentSession(db, ref.key);
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

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstNonEmpty(...values: string[]): string {
  return values.find((value) => value.trim() !== "")?.trim() ?? "";
}

function cleanParam(value: string | null): string {
  return value?.trim() ?? "";
}

function pendingCodexSessionFallback(db: RunnerDatabase, sessionId: string, error: unknown): Record<string, unknown> | null {
  if (!isEmptyRolloutError(error)) return null;
  const session = getAgentSession(db, `codex:${sessionId}`);
  if (!session) return null;
  return {
    id: session.session_key,
    sessionId: session.provider_session_id,
    provider: "codex",
    provider_session_id: session.provider_session_id,
    ephemeral: false,
    preview: session.preview,
    status: session.status || "running",
    turns: [],
    isRunning: ["running", "active", "busy", "inprogress"].includes(session.status.toLowerCase())
  };
}

function isEmptyRolloutError(error: unknown): boolean {
  return (error instanceof Error ? error.message : String(error)).includes("rollout at") &&
    (error instanceof Error ? error.message : String(error)).includes(" is empty");
}

function sessionPreview(prompt: string): string {
  const text = prompt.trim().replace(/\s+/g, " ");
  return text.length <= 120 ? text : `${text.slice(0, 119)}…`;
}

function assertProviderResult(expected: ExecutorProviderId, actual: ExecutorProviderId): void {
  if (actual !== expected) throw new Error(`provider result mismatch: expected ${expected}, received ${actual}`);
}

function safeSessionError(error: unknown): string {
  return redactedUserVisibleText(error instanceof Error ? error.message : String(error)).slice(0, 500) || "provider request failed";
}
