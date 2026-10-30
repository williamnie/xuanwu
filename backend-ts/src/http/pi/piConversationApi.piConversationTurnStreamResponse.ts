import { createBoundedEventStream } from "../boundedEventStream.ts";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { RunnerDatabase } from "../../db/database.ts";
import { failImContextProjectionReservation, markImContextProjectionPresented } from "../../db/repositories/imContextLifecycle.ts";
import { getPiConversation, updatePiConversation, type PiConversation } from "../../db/repositories/pi.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import { HttpError } from "../errors.ts";
import { piConversationPromptImages } from "./piConversationImages.ts";
import { piTurnSessionEvent, publishPiSessionEvent, type PiTurnSessionEvent } from "./piSessionEvents.ts";
import type { Router } from "../router.ts";
import { type ImConversationPromptProjection } from "../../integrations/im/imConversationContext.ts";
import { cleanString } from "../../util/values.ts";
import { PI_TURN_HEARTBEAT_MS, activePiRuns, lastAssistantErrorMessage, recordActivePiTurnEvent } from "./piConversationView.ts";
import type { PiConversationContext, PiConversationTurnResult, PiConversationTurn } from "./piConversationApi.model.ts";
import { piConversationListResponse, piConversationCreateResponse, piConversationResponse, parseObjectBody, pathPart, writeResponse, persistPiSessionIndex, requireConversationAgent, PI_SESSION_PROVIDER } from "./piConversationApi.createConversationWithRuntime.ts";
import { preparePiConversationTurn, piConversationTurnResult, touchPiConversation, piTurnEventBase } from "./piConversationApi.preparePiConversationTurn.ts";

export function registerPiConversationRoutes(router: Router, context: PiConversationContext): void {
  router.get("/api/pi/conversations", (request) => piConversationListResponse(context, request));
  router.post("/api/pi/conversations", async (request) => piConversationCreateResponse(context, request));
  router.get("/api/pi/conversations/:id", (request) => piConversationResponse(context, request));
  router.post("/api/pi/conversations/:id/messages", async (request) => piConversationMessageResponse(context, request));
  router.post("/api/pi/conversations/:id/interrupt", (request) => piConversationInterruptResponse(context, request));
}

export async function piConversationMessageResponse(context: PiConversationContext, request: Request): Promise<Response> {
  const body = await parseObjectBody(request);
  const id = pathPart(request, "conversations");
  try {
    const turn = await preparePiConversationTurn(context, id, body);
    return piConversationTurnStreamResponse(context, turn, request.signal);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error) throw new HttpError(400, error.message);
    throw error;
  }
}

export async function piConversationInterruptResponse(context: PiConversationContext, request: Request): Promise<Response> {
  const id = pathPart(request, "conversations");
  return writeResponse(() => interruptPiConversation(context, id));
}

export async function sendPiConversationMessage(
  context: PiConversationContext,
  id: string,
  body: Record<string, unknown>,
  trusted: { channelContext?: string; channelContextProjection?: ImConversationPromptProjection; continuationContext?: string; targetIssueId?: number } = {}
): Promise<PiConversationTurnResult> {
  const turn = await preparePiConversationTurn(context, id, body, trusted);
  return executePiConversationTurn(context, turn);
}

export async function executePiConversationTurn(
  context: PiConversationContext,
  turn: PiConversationTurn,
  onEvent?: (event: PiTurnSessionEvent) => void
): Promise<PiConversationTurnResult> {
  const { conversation, prompt, runtime } = turn;
  let unsubscribe = () => {};
  let contextPresented = false;
  try {
    unsubscribe = runtime.session.subscribe((event) => {
      if (!contextPresented && event.type === "agent_start" && turn.contextReservation) {
        try {
          markImContextProjectionPresented(context.database, turn.contextReservation);
          contextPresented = true;
        } catch (error) {
          console.warn("[pi-context] failed to present projection binding:",
            redactSensitiveText(error instanceof Error ? error.message : String(error)));
        }
      }
      const streamEvent = piTurnSessionEvent(event);
      recordActivePiTurnEvent(conversation.id, streamEvent);
      publishPiSessionEvent(context.bus, conversation, event, turn.turnID);
      if (streamEvent) onEvent?.(streamEvent);
    });
    await runtime.session.prompt(prompt, {
      expandPromptTemplates: false,
      images: piConversationPromptImages(context.database, prompt),
      preflightResult: (success) => {
        if (!success && turn.contextReservation && !contextPresented) {
          failImContextProjectionReservation(context.database, turn.contextReservation, "prompt_preflight_rejected");
        }
      },
      source: "rpc"
    });
    return piConversationTurnResult(turn);
  } finally {
    if (turn.contextReservation && !contextPresented) {
      failImContextProjectionReservation(context.database, turn.contextReservation, "turn_not_presented");
    }
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

export function piConversationTurnStreamResponse(
  context: PiConversationContext,
  turn: PiConversationTurn,
  signal?: AbortSignal
): Response {
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const output = createBoundedEventStream({ signal, onClose: clearHeartbeat });
  enqueuePiTurnEvent("accepted", piTurnEventBase(turn, { status: "accepted" }));
  if (!output.closed) heartbeat = setInterval(() => output.write(": heartbeat\n\n"), PI_TURN_HEARTBEAT_MS);
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
  }).finally(() => output.close());

  function enqueuePiTurnEvent(event: string, data: Record<string, unknown>): void {
    if (!output.closed) output.write(`id: ${turn.turnID}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function clearHeartbeat(): void {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
  }

  return new Response(output.stream, {
    status: 201,
    headers: {
      "cache-control": "no-cache, no-transform",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no"
    }
  });
}

export function piConversationTurnError(session: AgentSession): { code: string; message: string } {
  const message = session.state.errorMessage || lastAssistantErrorMessage(session);
  return {
    code: message === "Request was aborted" ? "interrupted" : "provider_error",
    message: redactSensitiveText(message)
  };
}

export async function resetConversationProjectRuntime(
  context: PiConversationContext,
  conversation: PiConversation
): Promise<PiConversation> {
  const { createOrRestorePiRuntime } = await import("./piRuntime.ts");
  const runtime = await createOrRestorePiRuntime(context.database, {
    agent: requireConversationAgent(context.database, conversation),
    bus: context.bus,
    conversationID: conversation.id,
    promptProfile: "chat"
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

export async function interruptPiConversation(context: PiConversationContext, id: string) {
  const active = activePiRuns.get(id);
  if (!active) return { interrupted: false };
  await active.session.abort();
  return { interrupted: true, conversation_id: id, pi_session_id: active.session.sessionId };
}

export function clearPiSessionProjectIndex(db: RunnerDatabase, providerSessionID: string): void {
  const sessionID = cleanString(providerSessionID);
  if (sessionID === "") return;
  db.sqlite.run(
    "update agent_sessions set project_id='' where provider=? and provider_session_id=?",
    [PI_SESSION_PROVIDER, sessionID]
  );
}
