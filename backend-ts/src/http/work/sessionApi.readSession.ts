import type { RunnerDatabase } from "../../db/database.ts";
import { getAgentSession, upsertAgentSession } from "../../db/repositories/agentSessions.ts";
import { getProject } from "../../db/repositories/projects.ts";
import { isExecutorProviderId, type SessionMessageInput, type SessionTurnsListInput } from "../../providers/types.ts";
import { correctedRuntimeRawRef, executionPolicyFromAgentSession, runtimeSettingsFromAgentSession, withSessionRuntimeSettings } from "./sessionRuntimeSettings.ts";
import { HttpError } from "../errors.ts";
import { reconcileCodexSessionIndex } from "./sessionIndexReconciler.ts";
import { providerSessionDetail } from "../../providers/core/sessionView.ts";
import { DEFAULT_EXECUTION_POLICY } from "../../providers/core/policyContracts.ts";
import { cleanString, isRecord } from "../../util/values.ts";
import type { SessionApiContext, QualifiedSessionRef } from "./sessionApi.model.ts";
import { parseSessionRef, publicAgentSessionOrNull, capableProvider, explicitExecutionPolicy, legacyExecutionPolicyBody, providerScopedModel, isEmptyRolloutError } from "./sessionApi.capableProvider.ts";
import { sessionProviders, qualifiedProviderSession, validateDeclaredSessionView, indexedActivityWins, codexProcessNotLoaded, cleanParam, stringBody, firstNonEmpty } from "./sessionApi.listSessions.ts";

export async function readSession(context: SessionApiContext, rawSessionID: string, includeTurns = false) {
  const ref = parseSessionRef(rawSessionID);
  const registeredProvider = isExecutorProviderId(ref.provider) ? sessionProviders(context, ref.key)?.[ref.provider] : undefined;
  if (!registeredProvider) {
    const indexed = publicAgentSessionOrNull(getAgentSession(context.database, ref.key));
    if (!indexed) throw new Error(`session provider "${ref.provider}" 当前 runner 未注册`);
    return indexed;
  }
  if (typeof registeredProvider.readSession !== "function") {
    const indexed = publicAgentSessionOrNull(getAgentSession(context.database, ref.key));
    if (!indexed) {
      throw new Error(`provider "${ref.provider}" 未提供 readSession，且 runner 没有可用的 session 索引`);
    }
    return await withSessionRuntimeSettings(
      context.database,
      ref.sessionId,
      qualifiedProviderSession(ref.provider, indexed),
      ref.provider
    );
  }
  const provider = capableProvider(context, ref.provider, "sessions", "readSession", ref.key);
  let result: Record<string, unknown>;
  try {
    result = await provider.readSession!(ref.sessionId, { includeTurns });
    validateDeclaredSessionView(provider, result, true, ref.sessionId);
  } catch (error) {
    const fallback = ref.provider === "codex" ? pendingCodexSessionFallback(context.database, ref.sessionId, error) : null;
    if (!fallback) throw error;
    result = fallback;
  }
  if (!includeTurns) result = { ...result, turns: [] };
  if (ref.provider === "codex") reconcileCodexSessionIndex(context.database, ref.sessionId, result);
  const qualified = qualifiedProviderSession(ref.provider, result);
  const indexed = publicAgentSessionOrNull(getAgentSession(context.database, ref.key));
  const merged = { ...(indexed ?? {}), ...qualified };
  const preserveIndexedActivity = ref.provider === "qoder"
    ? indexedActivityWins(indexed, qualified)
    : ref.provider === "codex" && codexProcessNotLoaded(qualified.status) && indexedActivityWins(indexed, qualified);
  const activityAware = preserveIndexedActivity
    ? { ...merged, status: indexed?.status, isRunning: true }
    : merged;
  const detail = reconcileProviderSessionMetadata(
    context.database,
    ref.provider,
    ref.sessionId,
    activityAware
  );
  return await withSessionRuntimeSettings(
    context.database,
    ref.sessionId,
    detail,
    ref.provider
  );
}

export async function listSessionTurns(
  context: SessionApiContext,
  rawSessionID: string,
  input: SessionTurnsListInput
) {
  const ref = parseSessionRef(rawSessionID);
  const provider = capableProvider(context, ref.provider, "sessions", "readSession", ref.key);
  if (typeof provider.listSessionTurns === "function") {
    return provider.listSessionTurns(ref.sessionId, input);
  }
  const detail = await provider.readSession!(ref.sessionId, { includeTurns: true });
  const turns = Array.isArray(detail.turns) ? detail.turns.filter(isRecord) : [];
  const ordered = input.sortDirection === "asc" ? turns : [...turns].reverse();
  const offset = positiveCursor(input.cursor);
  const limit = input.limit ?? 20;
  const data = ordered.slice(offset, offset + limit);
  const nextOffset = offset + data.length;
  return {
    data,
    ...(nextOffset < ordered.length ? { nextCursor: String(nextOffset) } : {})
  };
}

export function sessionTurnsInput(request: Request): SessionTurnsListInput {
  const params = new URL(request.url).searchParams;
  const itemsView = cleanParam(params.get("items_view"));
  const sortDirection = cleanParam(params.get("sort_direction"));
  return {
    cursor: cleanParam(params.get("cursor")),
    limit: sessionTurnLimit(params.get("limit")),
    itemsView: ["full", "notLoaded", "summary"].includes(itemsView)
      ? itemsView as SessionTurnsListInput["itemsView"]
      : "summary",
    sortDirection: sortDirection === "asc" ? "asc" : "desc"
  };
}

export function includeTurns(request: Request): boolean {
  return ["1", "true"].includes(cleanParam(new URL(request.url).searchParams.get("include_turns")).toLowerCase());
}

export function sessionTurnLimit(value: string | null): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 50) : 20;
}

export function positiveCursor(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function sessionMessageInput(context: SessionApiContext, ref: QualifiedSessionRef, body: Record<string, unknown>): SessionMessageInput {
  const mode = stringBody(body, "mode");
  const indexed = getAgentSession(context.database, ref.key);
  const project = indexed?.project_id ? getProject(context.database, indexed.project_id) : null;
  const stored = runtimeSettingsFromAgentSession(context.database, ref.sessionId, ref.provider);
  const inheritedPolicy = executionPolicyFromAgentSession(context.database, ref.sessionId, ref.provider)
    ?? project?.execution_policy
    ?? structuredClone(DEFAULT_EXECUTION_POLICY);
  const executionPolicy = explicitExecutionPolicy(body)
    ?? legacyExecutionPolicyBody(body, inheritedPolicy)
    ?? inheritedPolicy;
  return {
    projectId: project?.id,
    cwd: project?.cwd ?? "",
    sessionId: ref.sessionId,
    turnId: mode === "steer" ? latestSessionTurnID(context.database, ref) : "",
    prompt: stringBody(body, "prompt"),
    mode,
    model: providerScopedModel(ref.provider, firstNonEmpty(stringBody(body, "model"), stored.model ?? "")),
    reasoningEffort: firstNonEmpty(stringBody(body, "reasoning_effort"), stored.reasoning_effort ?? ""),
    serviceTier: firstNonEmpty(stringBody(body, "service_tier"), stored.service_tier ?? ""),
    approvalPolicy: firstNonEmpty(stringBody(body, "approval_policy"), stored.approval_policy ?? ""),
    sandbox: firstNonEmpty(stringBody(body, "sandbox"), stored.sandbox ?? ""),
    executionPolicy
  };
}

export function sessionID(request: Request): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const raw = parts[parts.indexOf("sessions") + 1] ?? "";
  const id = decodeURIComponent(raw).trim();
  if (id === "") throw new HttpError(400, "session id 不能为空");
  return id;
}

export function reconcileProviderSessionMetadata(
  db: RunnerDatabase,
  provider: string,
  sessionId: string,
  detail: Record<string, unknown>
): Record<string, unknown> {
  const indexed = getAgentSession(db, `${provider}:${sessionId}`);
  if (provider === "codex" || !indexed) return detail;
  const status = cleanString(detail.status) || (detail.isRunning === true ? "running" : "");
  const rawRef = correctedRuntimeRawRef(indexed.raw_ref, provider, detail);
  if (!status && !rawRef) return detail;
  const updated = upsertAgentSession(db, {
    provider,
    provider_session_id: sessionId,
    status,
    ...(rawRef ? { raw_ref: rawRef } : {})
  });
  return { ...detail, raw_ref: updated.raw_ref, status: status || detail.status };
}

export function latestSessionTurnID(db: RunnerDatabase, ref: QualifiedSessionRef): string {
  const session = getAgentSession(db, ref.key);
  if (!session?.raw_ref) return "";
  try {
    const raw = JSON.parse(session.raw_ref) as Record<string, unknown>;
    return typeof raw.provider_turn_id === "string" ? raw.provider_turn_id.trim() : "";
  } catch {
    return "";
  }
}

export function pendingCodexSessionFallback(db: RunnerDatabase, sessionId: string, error: unknown): Record<string, unknown> | null {
  if (!isEmptyRolloutError(error)) return null;
  const session = getAgentSession(db, `codex:${sessionId}`);
  if (!session) return null;
  return providerSessionDetail("codex", {
    sessionRef: session.provider_session_id,
    name: session.preview,
    preview: session.preview,
    status: session.status || "running",
    turns: [],
    isRunning: ["running", "active", "busy", "inprogress"].includes(session.status.toLowerCase()),
    extensions: { ephemeral: false }
  });
}
