import { getAgentSession, listAgentSessions, type AgentSession } from "../../db/repositories/agentSessions.ts";
import { getProject, ProjectNotFoundError, type Project } from "../../db/repositories/projects.ts";
import { isExecutorProviderId, type ExecutorProvider } from "../../providers/types.ts";
import { HttpError, json, parseJsonBody } from "../errors.ts";
import { reconcileCodexSessionIndexes } from "./sessionIndexReconciler.ts";
import { redactedUserVisibleText } from "../../util/redact.ts";
import { assertProviderSessionView, PROVIDER_SESSION_VIEW_CONTRACT } from "../../providers/core/sessionView.ts";
import type { ExecutorProviderManifest } from "../../providers/core/manifest.ts";
import { cleanString } from "../../util/values.ts";
import { providersForProjectID } from "../../nodes/remoteExecution.ts";
import type { SessionApiContext } from "./sessionApi.model.ts";

export async function listSessions(context: SessionApiContext, request: Request) {
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
  const providerNextCursors: string[] = [];
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
      providerNextCursors.push(result.nextCursor ?? "");
      for (const raw of result.data) validateDeclaredSessionView(provider, raw, false);
      if (provider.id === "codex") reconcileCodexSessionIndexes(context.database, result.data);
      for (const raw of result.data) {
        const item = qualifiedProviderSession(provider.id, raw);
        const key = String(item.id);
        const existing = merged.get(key);
        const preserveIndexedActivity = provider.id === "codex"
          ? codexProcessNotLoaded(item.status) && indexedActivityWins(existing, item)
          : indexedActivityWins(existing, item);
        const preserveIndexedStatus = preserveIndexedActivity || (provider.id !== "codex" && existing?.status);
        merged.set(key, {
          ...(existing ?? {}),
          ...item,
          // agent_sessions is the provider-neutral lifecycle index. Provider
          // discovery enriches it, but must not downgrade an indexed running
          // session to an idle historical summary.
          ...(preserveIndexedStatus ? { status: existing?.status } : {}),
          ...(preserveIndexedActivity ? { isRunning: true } : {})
        });
      }
    } catch (error) {
      providerErrors.push({ provider: provider.id, error: safeSessionError(error) });
    }
  }
  const data = [...merged.values()]
    .filter((item) => !filter.provider || item.provider === filter.provider)
    .slice(0, limit);
  const nextCursor = providers.length === 1 ? providerNextCursors[0] ?? "" : "";
  return { data, nextCursor, ...(providerErrors.length > 0 ? { provider_errors: providerErrors } : {}) };
}

/** 会话所属项目在远程节点上时，经该节点的 provider 访问会话。 */
export function sessionProviders(context: SessionApiContext, sessionKey: string): SessionApiContext["providers"] {
  if (sessionKey === "") return context.providers;
  return providersForProjectID(context.database, context.providers, getAgentSession(context.database, sessionKey)?.project_id ?? "");
}

export function providersForList(context: SessionApiContext, filter: { projectId: string; provider: string }): ExecutorProvider[] {
  const wanted = filter.provider || (filter.projectId ? getProject(context.database, filter.projectId)?.provider ?? "" : "");
  const providers = filter.projectId ? providersForProjectID(context.database, context.providers, filter.projectId) : context.providers;
  return Object.values(providers ?? {}).filter((provider): provider is ExecutorProvider => {
    if (!provider || (wanted && provider.id !== wanted)) return false;
    if (!provider.capabilities.includes("sessions") || typeof provider.listSessions !== "function") return false;
    return wanted !== "" || provider.runtimeStatus?.().ready !== false;
  });
}

export function validateDeclaredSessionView(
  provider: ExecutorProvider,
  value: Record<string, unknown>,
  detail: boolean,
  expectedSessionRef = ""
): void {
  const manifest = (provider as ExecutorProvider & { manifest?: ExecutorProviderManifest }).manifest;
  if (manifest?.sessionPresentation?.viewContract !== PROVIDER_SESSION_VIEW_CONTRACT) return;
  assertProviderSessionView(provider.id, value, { detail, expectedSessionRef });
}

export function sessionListInput(request: Request): { cursor: string; limit: number } {
  const params = new URL(request.url).searchParams;
  return { cursor: cleanParam(params.get("cursor")), limit: sessionLimit(params.get("limit")) };
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

export async function asyncResponse(write: () => Promise<unknown>, status = 200): Promise<Response> {
  try {
    return json(await write(), { status });
  } catch (error) {
    if (error instanceof ProjectNotFoundError) throw new HttpError(404, error.message);
    if (error instanceof Error) throw new HttpError(400, safeSessionError(error));
    throw error;
  }
}

export function publicAgentSession(session: AgentSession): Record<string, unknown> {
  return { ...session, id: session.session_key };
}

export function qualifiedProviderSession(provider: string, session: Record<string, unknown>): Record<string, unknown> {
  const providerSessionID = firstNonEmpty(
    cleanString(session.provider_session_id),
    cleanString(session.sessionId),
    cleanString(session.thread_id),
    providerIDFromKey(cleanString(session.id), provider)
  );
  return {
    ...session,
    id: providerSessionID ? `${provider}:${providerSessionID}` : cleanString(session.id),
    provider,
    ...(providerSessionID ? { provider_session_id: providerSessionID } : {})
  };
}

export function providerIDFromKey(value: string, provider: string): string {
  return value.startsWith(`${provider}:`) ? value.slice(provider.length + 1).trim() : "";
}

export function projectForSession(context: SessionApiContext, projectId: string): Project | null {
  if (projectId === "") return null;
  const project = getProject(context.database, projectId);
  if (!project) throw new ProjectNotFoundError();
  return project;
}

export function sessionLimit(value: string | null): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0) return 50;
  return Math.min(limit, 100);
}

export function stringBody(body: Record<string, unknown>, key: string): string {
  return typeof body[key] === "string" ? body[key].trim() : "";
}

export function firstNonEmpty(...values: string[]): string {
  return values.find((value) => value.trim() !== "")?.trim() ?? "";
}

export function indexedActivityWins(
  indexed: Record<string, unknown> | null | undefined,
  discovered: Record<string, unknown>
): boolean {
  if (!indexed || !activeSessionStatus(indexed.status)) return false;
  return discovered.isRunning !== true && !activeSessionStatus(discovered.status);
}

export function activeSessionStatus(value: unknown): boolean {
  const normalized = cleanString(value).toLowerCase().replaceAll("_", "-");
  return ["active", "busy", "in-progress", "inprogress", "running", "streaming"].includes(normalized);
}

export function codexProcessNotLoaded(value: unknown): boolean {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return cleanString((value as Record<string, unknown>).type).toLowerCase() === "notloaded";
  }
  return cleanString(value).toLowerCase().replaceAll("_", "") === "notloaded";
}

export function cleanParam(value: string | null): string {
  return value?.trim() ?? "";
}

export function safeSessionError(error: unknown): string {
  return redactedUserVisibleText(error instanceof Error ? error.message : String(error)).slice(0, 500) || "provider request failed";
}
