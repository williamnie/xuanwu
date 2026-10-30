import type { RunnerDatabase } from "../../db/database.ts";
import { resolveImProjectContextFromDatabase, type ImProjectContextResult } from "../im/imProjectContext.ts";
import { createExternalLink, listExternalLinksByExternal } from "../../db/repositories/externalLinks.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import type { FeishuNormalizedMessageEvent } from "./feishu.ts";
import { createFeishuMessageClient, type FeishuMessageClient, type FeishuTextMessageResult } from "./feishuClient.ts";
import { createFeishuChannelConnector, createFeishuImOutboundEnvelope } from "./feishuChannelConnector.ts";
import { routeFeishuConversation, type FeishuConversationRoute } from "./feishuConversationRouting.ts";
import type { FeishuIngestResult } from "./feishuIngest.ts";
import type { ChannelConnector } from "../channelConnectorContracts.ts";
import { deliverImOutboundNow } from "../im/imOutboundDelivery.ts";
import { cleanString } from "../../util/values.ts";
import type { FeishuAgentBridgeOptions, FeishuBridgeHandleInput, FeishuRunnerResult } from "./feishuAgentBridge.model.ts";

export const REPLY_LINK_TYPE = "feishu_agent_reply", REPLY_RELATIONSHIP = "agent_reply";

export const ACK_LINK_TYPE = "feishu_ack_reaction", ACK_RELATIONSHIP = "ack_reaction";

export const ACK_REACTION_EMOJI_TYPE = "OK";

export function messageSender(options: FeishuAgentBridgeOptions): FeishuMessageClient {
  return options.sender ?? createFeishuMessageClient({ config: options.config() });
}

export function deliveryConnector(options: FeishuAgentBridgeOptions): ChannelConnector {
  return options.connector ?? createFeishuChannelConnector({ config: options.config, sender: messageSender(options) });
}

export async function sendAckReaction(
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

export function replyPolicy(input: FeishuBridgeHandleInput): string {
  const decision = attentionDecision(input.ingest);
  if (input.event.chat_id === "") return "missing_chat_id";
  if (decision === "ignore") return "ignored_by_attention";
  return "";
}

export function conversationRoute(
  options: FeishuAgentBridgeOptions,
  input: FeishuBridgeHandleInput
): FeishuConversationRoute {
  return routeFeishuConversation(options.database, {
    clock: options.clock,
    event: input.event,
    prompt: input.event.text || "[Feishu attachment message]"
  });
}

export function projectContextForRoute(
  options: FeishuAgentBridgeOptions,
  input: FeishuBridgeHandleInput,
  route: FeishuConversationRoute
): ImProjectContextResult {
  return resolveImProjectContextFromDatabase(options.database, {
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

export function attentionDecision(input: FeishuIngestResult): string {
  const summary = input.normalized_summary;
  const decision = summary.attention_decision;
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return "";
  return cleanString((decision as Record<string, unknown>).decision);
}

export function alreadyReplied(db: RunnerDatabase, event: FeishuNormalizedMessageEvent): boolean {
  return listExternalLinksByExternal(db, {
    externalID: event.message_id,
    externalType: REPLY_LINK_TYPE,
    limit: 1,
    source: "feishu"
  }).some((item) => item.relationship === REPLY_RELATIONSHIP);
}

export function alreadyAcknowledged(db: RunnerDatabase, event: FeishuNormalizedMessageEvent): boolean {
  return listExternalLinksByExternal(db, {
    externalID: event.message_id,
    externalType: ACK_LINK_TYPE,
    limit: 1,
    source: "feishu"
  }).some((item) => item.relationship === ACK_RELATIONSHIP);
}

export function replyDedupeKey(event: FeishuNormalizedMessageEvent): string {
  return cleanString(event.dedupe_key) || `feishu:message:${cleanString(event.message_id)}`;
}

export function recordReplyLink(
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

export function fallbackConversationID(event: FeishuNormalizedMessageEvent): string {
  return `feishu:${event.message_id}`;
}

export function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error))
    .replace(/(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g, "[redacted-path]");
}
