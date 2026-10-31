import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../../db/database.ts";
import { createExternalLink, listExternalLinksByExternal } from "../../db/repositories/externalLinks.ts";
import { ensureImInteractionBinding } from "../../db/repositories/imInteractionBindings.ts";
import { createImProjectSelection, getImProjectSelection } from "../../db/repositories/imProjectSelections.ts";
import { listProjects } from "../../db/repositories/projects.ts";
import { routeImConversation } from "../im/imConversationRouting.ts";
import { deliverImOutboundNow } from "../im/imOutboundDelivery.ts";
import { resolveImProjectContextFromDatabase } from "../im/imProjectContext.ts";
import { IM_OUTBOUND_SCHEMA_VERSION, createImOutboundEnvelope, type ImInteractionV1 } from "../im/imChannelContracts.ts";
import { createTelegramImOutboundEnvelope, telegramConnectorTarget } from "./telegramChannelConnector.ts";
import type { Options, BridgeInput, RunResult } from "./telegramAgentBridge.model.ts";

export const REPLY_TYPE = "telegram_agent_reply";

export const ACK_TYPE = "telegram_ack_reaction";

export function prepare(options: Options, input: BridgeInput) {
  const route = routeImConversation(options.database, {
    message: input.normalized.message,
    prompt: input.normalized.prompt
  });
  const projectContext = resolveImProjectContextFromDatabase(options.database, {
    mappings: options.config().projectMappings,
    message: {
      chatId: input.normalized.message.conversation.id,
      senderId: input.normalized.message.sender.id
    },
    scopeKey: route.scopeKey,
    text: route.prompt || input.normalized.prompt
  });
  return { projectContext, route };
}

export async function sendReply(options: Options, input: BridgeInput, text: string, run: RunResult) {
  const chatId = input.normalized.message.conversation.id;
  const target = {
    connector_id: "telegram",
    conversation_id: chatId,
    ...(input.normalized.message.thread?.id ? { thread_id: input.normalized.message.thread.id } : {}),
    reply_to_message_id: input.normalized.message.message_id
  } as const;
  const envelope = createTelegramImOutboundEnvelope({
    actionGateRef: `external_events:${input.externalEventId}:reply-policy`,
    actionID: `telegram-reply:${input.normalized.message.message_id}`,
    authority: "deterministic_policy",
    correlationID: run.conversationId || run.route.conversationId,
    eventRef: `external_events:${input.externalEventId}`,
    idempotencyKey: `telegram-reply:${input.normalized.envelope.audit.idempotency_key}`,
    occurredAt: input.normalized.message.occurred_at,
    operation: "message.reply",
    target,
    text
  });
  const receipt = await deliverImOutboundNow({
    connector: options.connector,
    content: text,
    database: options.database,
    envelope,
    externalEventId: input.externalEventId,
    targetChatId: chatId,
    targetMessageId: input.normalized.message.message_id,
    targetThreadId: input.normalized.message.thread?.id
  });
  recordLink(options.database, input, run, receipt.provider_request_ref, REPLY_TYPE, "agent_reply");
  return { reason: "agent_reply_sent", replied: true };
}

export async function acknowledge(options: Options, input: BridgeInput): Promise<void> {
  if (linked(options.database, input, ACK_TYPE, "ack_reaction")) return;
  try {
    const chatId = input.normalized.message.conversation.id;
    const envelope = createTelegramImOutboundEnvelope({
      actionGateRef: `external_events:${input.externalEventId}:ack-policy`,
      actionID: `telegram-ack:${input.normalized.message.message_id}`,
      authority: "deterministic_policy",
      correlationID: input.normalized.envelope.event_id,
      eventRef: `external_events:${input.externalEventId}`,
      idempotencyKey: `telegram-ack:${input.normalized.envelope.audit.idempotency_key}`,
      occurredAt: input.normalized.message.occurred_at,
      operation: "reaction.add",
      reaction: "OK",
      target: { connector_id: "telegram", conversation_id: chatId, reply_to_message_id: input.normalized.message.message_id }
    });
    const receipt = await deliverImOutboundNow({
      connector: options.connector,
      content: "[reaction:OK]",
      database: options.database,
      envelope,
      externalEventId: input.externalEventId,
      targetChatId: chatId,
      targetMessageId: input.normalized.message.message_id
    });
    createExternalLink(options.database, {
      conversation_id: `telegram:${input.normalized.message.message_id}`,
      external_event_id: input.externalEventId,
      external_id: input.normalized.message.message_id,
      external_type: ACK_TYPE,
      loop_run_id: `telegram:${receipt.provider_request_ref}`,
      relationship: "ack_reaction",
      source: "telegram"
    });
  } catch {
    // Telegram reactions are optional and never block the Supervisor turn.
  }
}

export async function sendSelection(options: Options, input: BridgeInput, run: RunResult) {
  const now = new Date();
  const selectionId = stableSelectionId(input.normalized.envelope.audit.idempotency_key);
  const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  const chatId = input.normalized.message.conversation.id;
  const projects = new Map(listProjects(options.database).map((project) => [project.id, project.name]));
  const actions = run.projectContext.candidates.map((projectId, index) => ({
    action_id: `project_${index}`,
    label: projects.get(projectId) || projectId,
    style: index === 0 ? "primary" as const : "default" as const
  }));
  const { binding, selection } = options.database.transaction(() => {
    const selection = getImProjectSelection(options.database, selectionId) ?? createImProjectSelection(options.database, {
        candidates: run.projectContext.candidates,
        chatId,
        connectorId: "telegram",
        conversationId: run.route.conversationId,
        expiresAt,
        originalPrompt: run.route.prompt || input.normalized.prompt,
        scopeKey: run.route.scopeKey,
        selectionId,
        sourceMessageId: input.normalized.message.message_id,
        userId: input.normalized.message.sender.id,
        userOpenId: ""
      }, now);
    const binding = ensureImInteractionBinding(options.database, {
      actionKind: "project_selection",
      actionRef: `im_project_selections:${selection.selection_id}`,
      actions: actions.map((action, index) => ({ action_id: action.action_id, value: selection.candidates[index]! })),
      actor: { id: input.normalized.message.sender.id },
      connectorId: "telegram",
      conversationId: chatId,
      expiresAt: selection.expires_at,
      revision: 1,
      scopeKey: run.route.scopeKey,
      sourceMessageId: input.normalized.message.message_id
    }, now);
    return { binding, selection };
  }).immediate();
  const interaction: ImInteractionV1 = {
    actions,
    body: "检测到多个可能的项目；本次选择只用于继续当前这条请求。",
    expires_at: selection.expires_at,
    interaction_id: binding.interaction_id,
    kind: "choice",
    revision: binding.revision,
    schema_version: "xuanwu.im-interaction.v1",
    title: "选择项目"
  };
  const target = {
    connector_id: "telegram",
    conversation_id: chatId,
    reply_to_message_id: input.normalized.message.message_id,
    ...(input.normalized.message.thread?.id ? { thread_id: input.normalized.message.thread.id } : {})
  } as const;
  const envelope = createImOutboundEnvelope({
    actionGateRef: `im_project_selections:${selection.selection_id}:pending`,
    actionID: `telegram-project-selection:${selection.selection_id}`,
    authority: "deterministic_policy",
    correlationID: run.route.conversationId,
    eventRef: `external_events:${input.externalEventId}`,
    idempotencyKey: `telegram-project-selection:${selection.selection_id}`,
    payload: { interaction, operation: "interaction.send", schema_version: IM_OUTBOUND_SCHEMA_VERSION, target },
    target: telegramConnectorTarget(chatId)
  });
  const receipt = await deliverImOutboundNow({
    connector: options.connector,
    content: run.text,
    database: options.database,
    envelope,
    externalEventId: input.externalEventId,
    targetChatId: chatId,
    targetMessageId: input.normalized.message.message_id
  });
  recordLink(options.database, input, run, receipt.provider_request_ref, REPLY_TYPE, "agent_reply");
  return { reason: "project_selection_prompted", replied: true };
}

export function linked(db: RunnerDatabase, input: BridgeInput, externalType: string, relationship: string): boolean {
  return listExternalLinksByExternal(db, {
    externalID: input.normalized.message.message_id,
    externalType,
    limit: 1,
    source: "telegram"
  }).some((item) => item.relationship === relationship);
}

export function recordLink(db: RunnerDatabase, input: BridgeInput, run: RunResult, providerRef: string, externalType: string, relationship: string): void {
  createExternalLink(db, {
    conversation_id: run.conversationId || run.route.conversationId,
    external_event_id: input.externalEventId,
    external_id: input.normalized.message.message_id,
    external_type: externalType,
    issue_id: run.targetIssueId ?? 0,
    loop_run_id: `telegram:${providerRef}`,
    project_id: run.targetProjectId || "",
    relationship,
    source: "telegram"
  });
}

export function stableSelectionId(idempotencyKey: string): string {
  return `tg_${createHash("sha256").update(`telegram-project-selection:${idempotencyKey}`).digest("base64url").slice(0, 22)}`;
}
