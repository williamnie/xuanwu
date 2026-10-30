import { upsertAgentSession } from "../../db/repositories/agentSessions.ts";
import { lastSessionProject } from "../../db/repositories/preferences.ts";
import { interruptSession } from "../../runner/interrupt.ts";
import { isExecutorProviderId, type ExecutorProviderId, type SessionMessageInput } from "../../providers/types.ts";
import { runtimeRawRef, runtimeSettingsFromAgentSession } from "./sessionRuntimeSettings.ts";
import { json } from "../errors.ts";
import type { Router } from "../router.ts";
import type { SessionApiContext } from "./sessionApi.model.ts";
import { asyncResponse, listSessions, parseObjectBody } from "./sessionApi.listSessions.ts";
import { createSession, parseSessionRef, capableProvider, withSessionPolicy, assertProviderResult, completedOperationStatus } from "./sessionApi.capableProvider.ts";
import { readSession, sessionID, includeTurns, listSessionTurns, sessionTurnsInput, sessionMessageInput } from "./sessionApi.readSession.ts";

export function registerSessionRoutes(router: Router, context: SessionApiContext): void {
  router.get("/api/sessions", (request) => asyncResponse(() => listSessions(context, request)));
  router.post("/api/sessions", async (request) => {
    const body = await parseObjectBody(request);
    return asyncResponse(() => createSession(context, body), 201);
  });
  router.get("/api/sessions/preferences", () => json({ last_project_id: lastSessionProject(context.database) }));
  router.get("/api/sessions/:id", (request) => asyncResponse(() => readSession(
    context,
    sessionID(request),
    includeTurns(request)
  )));
  router.get("/api/sessions/:id/turns", (request) => asyncResponse(() => listSessionTurns(
    context,
    sessionID(request),
    sessionTurnsInput(request)
  )));
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

export async function sessionMessage(context: SessionApiContext, rawSessionID: string, body: Record<string, unknown>) {
  const ref = parseSessionRef(rawSessionID);
  if (!isExecutorProviderId(ref.provider)) throw new Error(`provider "${ref.provider}" 不支持 capability "resume_session"`);
  const provider = capableProvider(context, ref.provider, "resume_session", "sendSessionMessage", ref.key);
  const input = withSessionPolicy(provider, sessionMessageInput(context, ref, body), "local-user");
  const result = await provider.sendSessionMessage!(input);
  assertProviderResult(provider.id, result.provider);
  const status = completedOperationStatus(provider.id, input.prompt, result.turn_id);
  persistSessionTurn(context, provider.id, input, result.provider_session_id, result.turn_id, status);
  return { thread_id: result.provider_session_id, turn_id: result.turn_id, provider: provider.id, status, isRunning: status === "running" };
}

export function persistSessionTurn(
  context: SessionApiContext,
  provider: ExecutorProviderId,
  input: SessionMessageInput,
  sessionId: string,
  turnId: string,
  status: string
): void {
  if (sessionId === "") return;
  upsertAgentSession(context.database, {
    provider,
    provider_session_id: sessionId,
    project_id: input.projectId ?? "",
    raw_ref: {
      ...runtimeSettingsFromAgentSession(context.database, sessionId, provider),
      ...runtimeRawRef(input, turnId, provider)
    },
    status
  });
}
