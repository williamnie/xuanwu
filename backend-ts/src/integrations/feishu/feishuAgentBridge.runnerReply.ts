import type { RunnerDatabase } from "../../db/database.ts";
import { type ImProjectContextResult } from "../im/imProjectContext.ts";
import { type FeishuTextMessageResult } from "./feishuClient.ts";
import { createFeishuImOutboundEnvelope } from "./feishuChannelConnector.ts";
import { type FeishuConversationRoute } from "./feishuConversationRouting.ts";
import { resolveFeishuProjectSelectionBusinessAction, type FeishuProjectSelectionAction } from "./feishuProjectSelectionBridge.ts";
import { ingestPiGuardianEvent } from "../../pi/guardian/guardianEventIngest.ts";
import { resolveFeishuActionTarget } from "./feishuActionTarget.ts";
import { createImConversationCoordinator } from "../im/imConversationCoordinator.ts";
import { deliverImOutboundNow } from "../im/imOutboundDelivery.ts";
import { notificationPresentation } from "../../notifications/notificationPresentation.ts";
import { cleanString } from "../../util/values.ts";
import type { FeishuAgentBridgeOptions, FeishuBridgeHandleInput, FeishuRunnerResult, FeishuBridgeHandleResult } from "./feishuAgentBridge.model.ts";
import { sendAckReaction, alreadyReplied, replyDedupeKey, replyPolicy, conversationRoute, projectContextForRoute, deliveryConnector, fallbackConversationID, recordReplyLink, safeError } from "./feishuAgentBridge.sendAckReaction.ts";

export function createFeishuAgentBridge(options: FeishuAgentBridgeOptions) {
  const coordinator = createImConversationCoordinator<
    FeishuBridgeHandleInput,
    { projectContext: ImProjectContextResult; route: FeishuConversationRoute },
    FeishuRunnerResult
  >({
    acknowledge: (input) => sendAckReaction(options, input),
    alreadyHandled: (input) => alreadyReplied(options.database, input.event),
    dedupeKey: (input) => replyDedupeKey(input.event),
    policy: replyPolicy,
    prepare: (input) => {
      const route = conversationRoute(options, input);
      return { projectContext: projectContextForRoute(options, input, route), route };
    },
    reply: (input, runner) => sendReply(options, input, cleanString(runner.text), runner, "agent_reply_sent"),
    run: (input, prepared) => runnerReply(options, input, prepared.route, prepared.projectContext),
    text: (runner) => runner.text
  });
  return {
    handle: (input: FeishuBridgeHandleInput) => coordinator.handle(input),
    resolveProjectSelectionAction: (action: FeishuProjectSelectionAction) =>
      resolveFeishuProjectSelectionBusinessAction(options, action)
  };
}

export async function sendReply(
  options: FeishuAgentBridgeOptions,
  input: FeishuBridgeHandleInput,
  text: string,
  runner: FeishuRunnerResult,
  reason: string
): Promise<FeishuBridgeHandleResult> {
  const eventRef = input.ingest.event_id > 0 ? `external_events:${input.ingest.event_id}` : input.event.dedupe_key;
  const connector = deliveryConnector(options);
  const envelope = createFeishuImOutboundEnvelope({
    actionGateRef: `${eventRef}:reply-policy`,
    actionID: `feishu-reply:${input.event.message_id}`,
    authority: "deterministic_policy",
    correlationID: cleanString(runner.conversationId) || fallbackConversationID(input.event),
    eventRef,
    idempotencyKey: `feishu-reply:${input.event.dedupe_key}`,
    occurredAt: input.event.timestamp,
    operation: "message.reply",
    receiveID: input.event.chat_id,
    receiveIDType: "chat_id",
    text
  });
  const receipt = await deliverImOutboundNow({
    connector,
    content: text,
    database: options.database,
    envelope,
    externalEventId: input.ingest.event_id,
    targetChatId: input.event.chat_id,
    targetMessageId: input.event.message_id,
    targetThreadId: input.event.thread_id || input.event.root_id
  });
  const sent: FeishuTextMessageResult = {
    messageId: receipt.provider_request_ref
  };
  recordReplyLink(options.database, input, runner, sent);
  return { reason, replied: true };
}

export async function runnerReply(
  options: FeishuAgentBridgeOptions,
  input: FeishuBridgeHandleInput,
  route: FeishuConversationRoute,
  projectContext: ImProjectContextResult
): Promise<FeishuRunnerResult> {
  try {
    if (!options.runConversation) {
      throw new Error("Xuanwu Supervisor conversation provider is unavailable");
    }
    const targetProjectId = resolvedProjectId(projectContext);
    if (route.isNewCommand && route.prompt === "") {
      return { conversationId: route.conversationId, projectId: "", targetProjectId, text: newConversationText(options.database) };
    }
    const prompt = route.prompt || input.event.text || "[Feishu attachment message]";
    const actionTarget = resolveFeishuActionTarget(options.database, input.event);
    const resolvedTargetProjectID = actionTarget.projectID || targetProjectId;
    const result = await options.runConversation({
      conversationId: route.conversationId,
      event: input.event,
      projectId: "",
      targetProjectId: resolvedTargetProjectID,
      targetProjectSource: actionTarget.source === "none"
        ? projectContext.source
        : `${actionTarget.source}:${actionTarget.sourceRef}`,
      targetIssueId: actionTarget.issueID || undefined,
      prompt
    });
    return { ...result, projectId: "", targetProjectId: resolvedTargetProjectID, text: result.text };
  } catch (error) {
    const message = safeError(error);
    ingestPiGuardianEvent(options.database, {
      eventType: "guardian.pi_supervisor.unavailable",
      idempotencyKey: `guardian.pi_supervisor.unavailable:feishu:${input.event.message_id}`,
      normalizedPayload: {
        channel: "feishu",
        conversation_id: route.conversationId,
        error: message,
        source_message_id: input.event.message_id
      },
      projectID: resolvedProjectId(projectContext),
      severity: "urgent",
      source: "supervisor",
      sourceEventID: input.ingest.event_id > 0
        ? `external_events:${input.ingest.event_id}`
        : input.event.dedupe_key
    });
    return {
      conversationId: fallbackConversationID(input.event),
      text: bridgeErrorText(options.database, message)
    };
  }
}

export function newConversationText(db: RunnerDatabase): string {
  const presentation = notificationPresentation(db);
  return presentation.language === "en-US"
    ? `${presentation.display_name}: A fresh conversation is ready. Send the next message when you are ready.`
    : `${presentation.display_name}：新会话准备好了，继续发消息就行。`;
}

export function bridgeErrorText(db: RunnerDatabase, error: string): string {
  const presentation = notificationPresentation(db);
  return presentation.language === "en-US"
    ? `${presentation.display_name} could not hand this request to Runner: ${error}. Try again later, or include the project name and goal.`
    : `${presentation.display_name} 暂时没接住这条请求：${error}。你可以稍后重试；如果目标不明确，补上项目名和要做的事。`;
}

export function resolvedProjectId(context: ImProjectContextResult): string {
  return context.status === "resolved" ? context.projectId : "";
}
