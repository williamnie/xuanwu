import type { RunnerDatabase } from "../db/database.ts";
import { resolveFeishuProjectContextFromDatabase, type FeishuProjectContextResult } from "./feishuProjectContext.ts";
import { createExternalLink, listExternalLinksByExternal } from "../db/repositories/externalLinks.ts";
import { redactSensitiveText } from "../util/redact.ts";
import type { FeishuConnectorConfig, FeishuNormalizedMessageEvent } from "./feishu.ts";
import { createFeishuMessageClient, type FeishuMessageClient, type FeishuTextMessageResult } from "./feishuClient.ts";
import { createFeishuChannelConnector, createFeishuImOutboundEnvelope } from "./feishuChannelConnector.ts";
import {
  routeFeishuConversation,
  type FeishuConversationClock,
  type FeishuConversationRoute
} from "./feishuConversationRouting.ts";
import {
  resolveFeishuProjectSelectionBusinessAction,
  type FeishuProjectSelectionAction
} from "./feishuProjectSelectionBridge.ts";
import type { FeishuIngestResult } from "./feishuIngest.ts";
import { ingestPiGuardianEvent } from "../pi/guardianEventIngest.ts";
import { resolveFeishuActionTarget } from "./feishuActionTarget.ts";
import { createImConversationCoordinator } from "./imConversationCoordinator.ts";
import type { ChannelConnector } from "./channelConnectorContracts.ts";
import { deliverImOutboundNow } from "./imOutboundDelivery.ts";

export type FeishuConversationRunner = (input: FeishuRunnerInput) => Promise<FeishuRunnerResult>;
export type FeishuRunnerInput = {
  conversationId: string;
  event: FeishuNormalizedMessageEvent;
  prompt: string;
  projectId: string;
  targetProjectId?: string;
  targetProjectSource?: string;
  targetIssueId?: number;
};
export type FeishuRunnerResult = {
  conversationId?: string;
  projectId?: string;
  targetProjectId?: string;
  text: string;
};
type FeishuAgentBridgeOptions = {
  clock?: FeishuConversationClock;
  config: () => FeishuConnectorConfig;
  connector?: ChannelConnector;
  database: RunnerDatabase;
  runConversation?: FeishuConversationRunner;
  sender?: FeishuMessageClient;
};
export type FeishuBridgeHandleInput = { event: FeishuNormalizedMessageEvent; ingest: FeishuIngestResult };
export type FeishuBridgeHandleResult = { reason: string; replied: boolean };

const REPLY_LINK_TYPE = "feishu_agent_reply", REPLY_RELATIONSHIP = "agent_reply";
const ACK_LINK_TYPE = "feishu_ack_reaction", ACK_RELATIONSHIP = "ack_reaction";
const ACK_REACTION_EMOJI_TYPE = "OK";
const NEW_CONVERSATION_ACK_TEXT = "已开启新的 Supervisor 上下文。你可以继续发下一条消息。";

export function createFeishuAgentBridge(options: FeishuAgentBridgeOptions) {
  const coordinator = createImConversationCoordinator<
    FeishuBridgeHandleInput,
    { projectContext: FeishuProjectContextResult; route: FeishuConversationRoute },
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

async function sendReply(
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

async function runnerReply(
  options: FeishuAgentBridgeOptions,
  input: FeishuBridgeHandleInput,
  route: FeishuConversationRoute,
  projectContext: FeishuProjectContextResult
): Promise<FeishuRunnerResult> {
  try {
    if (!options.runConversation) {
      throw new Error("Xuanwu Supervisor conversation provider is unavailable");
    }
    const targetProjectId = resolvedProjectId(projectContext);
    if (route.isNewCommand && route.prompt === "") {
      return { conversationId: route.conversationId, projectId: "", targetProjectId, text: NEW_CONVERSATION_ACK_TEXT };
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
      text: `我尝试交给 Runner 时出错了：${message}。你可以稍后重试，或补充项目名和目标再发我一次。`
    };
  }
}

function messageSender(options: FeishuAgentBridgeOptions): FeishuMessageClient {
  return options.sender ?? createFeishuMessageClient({ config: options.config() });
}

function deliveryConnector(options: FeishuAgentBridgeOptions): ChannelConnector {
  return options.connector ?? createFeishuChannelConnector({ config: options.config, sender: messageSender(options) });
}

async function sendAckReaction(
  options: FeishuAgentBridgeOptions,
  input: FeishuBridgeHandleInput
): Promise<void> {
  if (options.connector) {
    if (!options.connector.manifest.capabilities.some((capability) => capability.id === "reaction.add")) return;
  } else if (!messageSender(options).addMessageReaction) return;
  if (alreadyAcknowledged(options.database, input.event)) return;
  try {
    const eventRef = input.ingest.event_id > 0 ? `external_events:${input.ingest.event_id}` : input.event.dedupe_key;
    const connector = deliveryConnector(options);
    const envelope = createFeishuImOutboundEnvelope({
      actionGateRef: `${eventRef}:ack-policy`,
      actionID: `feishu-ack:${input.event.message_id}`,
      authority: "deterministic_policy",
      correlationID: input.event.dedupe_key,
      eventRef,
      idempotencyKey: `feishu-ack:${input.event.dedupe_key}`,
      occurredAt: input.event.timestamp,
      operation: "reaction.add",
      reaction: ACK_REACTION_EMOJI_TYPE,
      receiveID: input.event.chat_id,
      receiveIDType: "chat_id",
      replyToMessageID: input.event.message_id
    });
    const receipt = await deliverImOutboundNow({
      connector,
      content: `[reaction:${ACK_REACTION_EMOJI_TYPE}]`,
      database: options.database,
      envelope,
      externalEventId: input.ingest.event_id,
      targetChatId: input.event.chat_id,
      targetMessageId: input.event.message_id,
      targetThreadId: input.event.thread_id || input.event.root_id
    });
    createExternalLink(options.database, {
      conversation_id: fallbackConversationID(input.event),
      external_event_id: input.ingest.event_id,
      external_id: input.event.message_id,
      external_type: ACK_LINK_TYPE,
      loop_run_id: `feishu_reaction:${receipt.provider_request_ref}`,
      relationship: ACK_RELATIONSHIP,
      source: "feishu"
    });
  } catch (error) {
    console.warn(JSON.stringify({
      action: "feishu_ack_reaction",
      error: safeError(error),
      ok: false
    }));
  }
}

function replyPolicy(input: FeishuBridgeHandleInput): string {
  const decision = attentionDecision(input.ingest);
  if (input.event.chat_id === "") return "missing_chat_id";
  if (decision === "ignore") return "ignored_by_attention";
  return "";
}

function conversationRoute(
  options: FeishuAgentBridgeOptions,
  input: FeishuBridgeHandleInput
): FeishuConversationRoute {
  return routeFeishuConversation(options.database, {
    clock: options.clock,
    event: input.event,
    prompt: input.event.text || "[Feishu attachment message]"
  });
}

function projectContextForRoute(
  options: FeishuAgentBridgeOptions,
  input: FeishuBridgeHandleInput,
  route: FeishuConversationRoute
): FeishuProjectContextResult {
  return resolveFeishuProjectContextFromDatabase(options.database, {
    mappings: options.config().projectMappings,
    message: {
      chatId: input.event.chat_id,
      senderId: input.event.sender.id,
      senderOpenId: input.event.sender.open_id
    },
    scopeKey: route.scopeKey,
    text: route.prompt || input.event.text
  });
}

function resolvedProjectId(context: FeishuProjectContextResult): string {
  return context.status === "resolved" ? context.projectId : "";
}

function attentionDecision(input: FeishuIngestResult): string {
  const summary = input.normalized_summary;
  const decision = summary.attention_decision;
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return "";
  return cleanString((decision as Record<string, unknown>).decision);
}

function alreadyReplied(db: RunnerDatabase, event: FeishuNormalizedMessageEvent): boolean {
  return listExternalLinksByExternal(db, {
    externalID: event.message_id,
    externalType: REPLY_LINK_TYPE,
    limit: 1,
    source: "feishu"
  }).some((item) => item.relationship === REPLY_RELATIONSHIP);
}

function alreadyAcknowledged(db: RunnerDatabase, event: FeishuNormalizedMessageEvent): boolean {
  return listExternalLinksByExternal(db, {
    externalID: event.message_id,
    externalType: ACK_LINK_TYPE,
    limit: 1,
    source: "feishu"
  }).some((item) => item.relationship === ACK_RELATIONSHIP);
}

function replyDedupeKey(event: FeishuNormalizedMessageEvent): string {
  return cleanString(event.dedupe_key) || `feishu:message:${cleanString(event.message_id)}`;
}

function recordReplyLink(
  db: RunnerDatabase,
  input: FeishuBridgeHandleInput,
  runner: FeishuRunnerResult,
  sent: FeishuTextMessageResult
): void {
  createExternalLink(db, {
    conversation_id: cleanString(runner.conversationId) || fallbackConversationID(input.event),
    external_event_id: input.ingest.event_id,
    external_id: input.event.message_id,
    external_type: REPLY_LINK_TYPE,
    loop_run_id: `feishu_reply:${sent.messageId}`,
    project_id: cleanString(runner.targetProjectId) || cleanString(runner.projectId),
    relationship: REPLY_RELATIONSHIP,
    source: "feishu"
  });
}

function fallbackConversationID(event: FeishuNormalizedMessageEvent): string {
  return `feishu:${event.message_id}`;
}

function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error))
    .replace(/(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g, "[redacted-path]");
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
