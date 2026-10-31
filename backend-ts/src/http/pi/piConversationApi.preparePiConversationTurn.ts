import type { RunnerDatabase } from "../../db/database.ts";
import { failImContextProjectionReservation, reserveImContextProjection, type ImContextProjectionReservation } from "../../db/repositories/imContextLifecycle.ts";
import { updatePiConversation, type PiConversation } from "../../db/repositories/pi.ts";
import { startProjectLoop } from "../../runner/projectLoopManager.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import { HttpError } from "../errors.ts";
import { resolvePiConversationSessionFile } from "./piConversationTranscript.ts";
import type { PiRuntimeSession } from "./piRuntime.ts";
import { recordSupervisorContextResolutionAudit, resolveSupervisorContext, type SupervisorContextResolution } from "../../pi/supervisor/supervisorContextResolver.ts";
import { linkSupervisorCommitmentsForConversation } from "../../pi/supervisor/supervisorCommitments.ts";
import { isReviewConversationIntent, reviewConversationSource } from "./piConversationReview.ts";
import { managedCodeAgentCatalog } from "../../providers/core/codeAgentDirectory.ts";
import { renderImConversationPrompt, type ImConversationPromptProjection } from "../../integrations/im/imConversationContext.ts";
import { resolvePiChatToolMode } from "../../pi/runtime/runtimePromptProfile.ts";
import { type AppLanguage } from "../../i18n/language.ts";
import { cleanString } from "../../util/values.ts";
import { activePiRuns, ensureConversationTitle, piConversationResultText } from "./piConversationView.ts";
import { conversationAuthorization, imRunnerChatSource, runnerChatSource } from "./piConversationAuthorization.ts";
import type { PiConversationContext, PiConversationTurn, PiConversationTurnResult } from "./piConversationApi.model.ts";
import { positiveInteger, requireConversation, conversationOutputLanguage, optionalConversationProject, oneShotProjectSource, requireConversationProject, requireConversationAgent } from "./piConversationApi.createConversationWithRuntime.ts";

export async function preparePiConversationTurn(
  context: PiConversationContext,
  id: string,
  body: Record<string, unknown>,
  trusted: { channelContext?: string; channelContextProjection?: ImConversationPromptProjection; continuationContext?: string; targetIssueId?: number } = {}
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
  const imSource = imRunnerChatSource(trusted.channelContextProjection?.connectorID);
  const source = review
    ? imSource?.replace(/_runner_chat$/, "_runner_review") ?? reviewConversationSource(titledConversation)
    : imSource ?? runnerChatSource(titledConversation);
  const resolvedSource = source ?? (review ? "runner_review" : "runner_chat");
  const turnID = crypto.randomUUID();
  const outputLanguage = conversationOutputLanguage(context.database, body.language, prompt);
  let contextReservation: ImContextProjectionReservation | undefined;
  let channelContext = cleanString(trusted.channelContext);
  const projection = trusted.channelContextProjection;
  if (projection && projection.piConversationID === titledConversation.id && projection.events.length > 0) {
    try {
      contextReservation = reserveImContextProjection(context.database, {
        connectorID: projection.connectorID,
        conversationID: titledConversation.id,
        events: projection.events.map((event) => ({
          direction: event.direction,
          included: event.included,
          messageRef: event.messageRef,
          projectionHash: event.projectionHash,
          sourceRowID: event.sourceRowID
        })),
        scopeKey: projection.scopeKey,
        turnID
      });
      const accepted = new Set(contextReservation.accepted.map((item) => `${item.direction}:${item.sourceRowID}`));
      channelContext = renderImConversationPrompt(projection.events.filter((event) =>
        accepted.has(`${event.direction}:${event.sourceRowID}`)));
    } catch (error) {
      console.warn("[pi-context] projection reservation unavailable:", redactSensitiveText(error instanceof Error ? error.message : String(error)));
      channelContext = "";
    }
  }
  channelContext = [cleanString(trusted.continuationContext), channelContext].filter(Boolean).join("\n");
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
  let runtime: PiRuntimeSession;
  try {
    runtime = await openConversationRuntime(
      context,
      titledConversation,
      supervisorContext,
      intent,
      prompt,
      turnID,
      resolvedSource,
      channelContext,
      projection ? {
        connectorID: projection.connectorID,
        conversationID: projection.conversationID
      } : undefined,
      outputLanguage
    );
  } catch (error) {
    if (contextReservation) failImContextProjectionReservation(context.database, contextReservation, "runtime_open_failed");
    throw error;
  }
  let activeConversation: PiConversation;
  try {
    activeConversation = touchPiConversation(context.database, titledConversation);
  } catch (error) {
    if (contextReservation) failImContextProjectionReservation(context.database, contextReservation, "conversation_touch_failed");
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
  return { contextReservation, conversation: activeConversation, prompt, runtime, turnID };
}

export function piConversationTurnResult(turn: PiConversationTurn): PiConversationTurnResult {
  const { conversation, runtime, turnID } = turn;
  return {
    conversation_id: conversation.id,
    pi_session_id: runtime.session.sessionId,
    session_file: runtime.session.sessionFile ?? "",
    status: runtime.session.state.errorMessage ? "failed" : "completed",
    title: conversation.title,
    text: piConversationResultText(runtime.session),
    message_count: runtime.session.state.messages.filter(message => message.role !== "system").length,
    turn_id: turnID
  };
}

export function piTurnEventBase(
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

export function touchPiConversation(db: RunnerDatabase, conversation: PiConversation): PiConversation {
  return updatePiConversation(db, conversation.id, { status: conversation.status });
}

export async function openConversationRuntime(
  context: PiConversationContext,
  conversation: PiConversation,
  supervisorContext: SupervisorContextResolution,
  intent = "",
  userPrompt = "",
  turnID = "",
  source?: string,
  channelContext = "",
  notificationTarget?: {
    connectorID: string;
    conversationID: string;
    replyToMessageID?: string;
    threadID?: string;
  },
  outputLanguage?: AppLanguage
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
    auditSystemRestart: context.auditSystemRestart,
    authorization: conversationAuthorization(review, toolProject, PI_RUNNER_CHAT_ACTIONS),
    bus: context.bus,
    cliConnectorDirs: context.config?.cliConnectors.manifestDirs,
    channelContext,
    chatToolMode: resolvePiChatToolMode(review),
    codeAgentCatalog: context.providersRegistry ? managedCodeAgentCatalog(context.providersRegistry) : [],
    conversationID: conversation.id,
    config: context.config,
    onIssueEnqueued: (projectID) => startProjectLoop({
      bus: context.bus,
      database: context.database,
      providers: context.providers
    }, projectID, { forceOnce: true }),
    notificationTarget,
    outputLanguage,
    project,
    promptProfile: "chat",
    providers: context.providers,
    restartDelayMs: context.restartDelayMs,
    restartProcess: context.restartProcess,
    sessionFile: resolvePiConversationSessionFile(conversation.session_file),
    toolProject,
    source,
    sourceTurn: { id: turnID, source, userPrompt },
    supervisorContext,
    supervisorManaged: context.supervisorManaged });
}
