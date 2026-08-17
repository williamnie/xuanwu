import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../db/database.ts";
import { createExternalLink, listExternalLinksByExternal } from "../db/repositories/externalLinks.ts";
import { ensureImInteractionBinding } from "../db/repositories/imInteractionBindings.ts";
import { consumeImProjectSelection, createImProjectSelection, getImProjectSelection } from "../db/repositories/imProjectSelections.ts";
import { listProjects } from "../db/repositories/projects.ts";
import { ingestPiGuardianEvent } from "../pi/guardianEventIngest.ts";
import { redactSensitiveText } from "../util/redact.ts";
import type { ChannelConnector } from "./channelConnectorContracts.ts";
import { resolveImActionTarget } from "./imActionTarget.ts";
import { createImConversationCoordinator } from "./imConversationCoordinator.ts";
import { buildImConversationPromptContext } from "./imConversationContext.ts";
import { routeImConversation, type ImConversationRoute } from "./imConversationRouting.ts";
import { deliverImOutboundNow } from "./imOutboundDelivery.ts";
import { resolveImProjectContextFromDatabase, type ImProjectContextResult } from "./imProjectContext.ts";
import { IM_OUTBOUND_SCHEMA_VERSION, createImOutboundEnvelope, type ImInteractionV1 } from "./imChannelContracts.ts";
import { createTelegramImOutboundEnvelope, telegramConnectorTarget } from "./telegramChannelConnector.ts";
import type { TelegramInboundHandler } from "./telegramReceiver.ts";
import type { TelegramConnectorConfig } from "./telegramTypes.ts";

export type TelegramSupervisorConversation = (input: {
  channelContext: string;
  conversationId: string;
  prompt: string;
  targetIssueId?: number;
  targetProjectId: string;
  targetProjectSource?: string;
  title: string;
}) => Promise<{ conversationId?: string; targetProjectId?: string; text: string }>;

type Options = {
  config: () => TelegramConnectorConfig;
  connector: ChannelConnector;
  database: RunnerDatabase;
  runSupervisorConversation?: TelegramSupervisorConversation;
};

type BridgeInput = Parameters<TelegramInboundHandler>[0];
type RunResult = {
  conversationId?: string;
  kind: "reply" | "selection";
  projectContext: ImProjectContextResult;
  route: ImConversationRoute;
  targetIssueId?: number;
  targetProjectId?: string;
  text: string;
};

const REPLY_TYPE = "telegram_agent_reply";
const ACK_TYPE = "telegram_ack_reaction";

export function createTelegramAgentBridge(options: Options) {
  const coordinator = createImConversationCoordinator<BridgeInput, {
    projectContext: ImProjectContextResult;
    route: ImConversationRoute;
  }, RunResult>({
    acknowledge: (input) => acknowledge(options, input),
    alreadyHandled: (input) => linked(options.database, input, REPLY_TYPE, "agent_reply"),
    dedupeKey: (input) => input.normalized.envelope.audit.idempotency_key,
    policy: (input) => input.normalized.attention.decision === "ignore" ? "ignored_by_attention" : "",
    prepare: (input) => prepare(options, input),
    reply: (input, run) => run.kind === "selection"
      ? sendSelection(options, input, run)
      : sendReply(options, input, run.text, run),
    run: (input, prepared) => runConversation(options, input, prepared.route, prepared.projectContext),
    text: (run) => run.text
  });
  return {
    handle: (input: BridgeInput) => coordinator.handle(input),
    presentInteractionResult: (input: { callbackId: string; chatId: string; text: string; threadId: string }) =>
      sendStandaloneText(options, input.chatId, input.text, `${input.callbackId}:result`, input.threadId),
    resolveProjectSelection: (input: {
      callbackId: string; chatId: string; messageId: string; projectId: string; selectionId: string; threadId: string; userId: string;
    }) => resolveProjectSelection(options, input)
  };
}

function prepare(options: Options, input: BridgeInput) {
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

async function runConversation(
  options: Options,
  input: BridgeInput,
  route: ImConversationRoute,
  projectContext: ImProjectContextResult
): Promise<RunResult> {
  const resolvedProject = projectContext.status === "resolved" ? projectContext.projectId : "";
  if (route.isNewCommand && route.prompt === "") {
    return { kind: "reply", projectContext, route, targetProjectId: resolvedProject, text: "已开启新的 Supervisor 上下文。你可以继续发下一条消息。" };
  }
  if (projectContext.status === "ambiguous") {
    return { kind: "selection", projectContext, route, text: "请选择要用于处理这条请求的项目。" };
  }
  try {
    if (!options.runSupervisorConversation) throw new Error("Xuanwu Supervisor conversation provider is unavailable");
    const replyTo = id(input.update.message?.reply_to_message?.message_id);
    const target = resolveImActionTarget(options.database, {
      connectorId: "telegram",
      conversationId: input.normalized.message.conversation.id,
      repliedMessageId: replyTo,
      text: route.prompt || input.normalized.prompt
    });
    const targetProjectId = target.projectID || resolvedProject;
    const result = await options.runSupervisorConversation({
      channelContext: buildImConversationPromptContext(options.database, {
        conversation: {
          connectorId: "telegram",
          conversationId: input.normalized.message.conversation.id,
          currentMessageId: input.normalized.message.message_id,
          threadId: input.normalized.message.thread?.id ?? ""
        }
      }),
      conversationId: route.conversationId,
      prompt: route.prompt || input.normalized.prompt || "[Telegram attachment message]",
      targetIssueId: target.issueID || undefined,
      targetProjectId,
      targetProjectSource: target.source === "none" ? projectContext.source : `${target.source}:${target.sourceRef}`,
      title: `Telegram · ${input.normalized.message.conversation.id}`
    });
    return {
      ...result,
      kind: "reply",
      projectContext,
      route,
      targetIssueId: target.issueID || undefined,
      targetProjectId: result.targetProjectId ?? targetProjectId
    };
  } catch (error) {
    const message = safeError(error);
    ingestPiGuardianEvent(options.database, {
      eventType: "guardian.pi_supervisor.unavailable",
      idempotencyKey: `guardian.pi_supervisor.unavailable:telegram:${input.normalized.message.message_id}`,
      normalizedPayload: {
        channel: "telegram",
        conversation_id: route.conversationId,
        error: message,
        source_message_id: input.normalized.message.message_id
      },
      projectID: resolvedProject,
      severity: "urgent",
      source: "supervisor",
      sourceEventID: `external_events:${input.externalEventId}`
    });
    return { kind: "reply", projectContext, route, text: `我尝试交给 Runner 时出错了：${message}。你可以稍后重试，或补充项目名和目标再发我一次。` };
  }
}

async function sendReply(options: Options, input: BridgeInput, text: string, run: RunResult) {
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

async function acknowledge(options: Options, input: BridgeInput): Promise<void> {
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

async function sendSelection(options: Options, input: BridgeInput, run: RunResult) {
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

async function resolveProjectSelection(options: Options, input: {
  callbackId: string; chatId: string; messageId: string; projectId: string; selectionId: string; threadId: string; userId: string;
}) {
  const result = consumeImProjectSelection(options.database, {
    chatId: input.chatId,
    connectorId: "telegram",
    now: new Date(),
    projectId: input.projectId,
    selectionId: input.selectionId,
    userId: input.userId,
    userOpenId: ""
  });
  if (result.status !== "consumed" || !result.selection) return { ok: false, status: `project_selection_${result.status}` };
  const selection = result.selection;
  await sendStandaloneText(options, selection.chat_id, `已选择 ${input.projectId}，我会用它处理刚才这句。`, `${input.callbackId}:selected`, input.threadId);
  if (!options.runSupervisorConversation) return { ok: true, status: "project_selection_saved" };
  try {
    const reply = await options.runSupervisorConversation({
      channelContext: buildImConversationPromptContext(options.database, {
        conversation: {
          connectorId: "telegram",
          conversationId: selection.chat_id,
          currentMessageId: selection.source_message_id,
          threadId: input.threadId
        }
      }),
      conversationId: selection.conversation_id,
      prompt: selection.original_prompt,
      targetProjectId: input.projectId,
      targetProjectSource: "interaction_select",
      title: `Telegram · ${selection.chat_id}`
    });
    if (reply.text.trim()) await sendStandaloneText(options, selection.chat_id, reply.text, `${input.callbackId}:continued`, input.threadId);
    return { ok: true, status: "project_selection_continued" };
  } catch (error) {
    await sendStandaloneText(options, selection.chat_id, `已选择 ${input.projectId}，但继续处理时出错：${safeError(error)}。`, `${input.callbackId}:failed`, input.threadId);
    return { ok: false, status: "project_selection_continue_failed" };
  }
}

async function sendStandaloneText(options: Options, chatId: string, text: string, key: string, threadId = ""): Promise<void> {
  const target = {
    connector_id: "telegram",
    conversation_id: chatId,
    ...(threadId ? { thread_id: threadId } : {})
  } as const;
  const envelope = createTelegramImOutboundEnvelope({
    actionGateRef: `telegram-interaction:${key}`,
    actionID: `telegram-interaction-reply:${key}`,
    authority: "deterministic_policy",
    correlationID: `telegram-interaction:${key}`,
    eventRef: `telegram-interaction:${key}`,
    idempotencyKey: `telegram-interaction-reply:${key}`,
    operation: "message.reply",
    target,
    text
  });
  await deliverImOutboundNow({ connector: options.connector, content: text, database: options.database, envelope, targetChatId: chatId });
}

function linked(db: RunnerDatabase, input: BridgeInput, externalType: string, relationship: string): boolean {
  return listExternalLinksByExternal(db, {
    externalID: input.normalized.message.message_id,
    externalType,
    limit: 1,
    source: "telegram"
  }).some((item) => item.relationship === relationship);
}

function recordLink(db: RunnerDatabase, input: BridgeInput, run: RunResult, providerRef: string, externalType: string, relationship: string): void {
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

function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error))
    .replace(/(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g, "[redacted-path]");
}

function id(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return typeof value === "string" ? value.trim() : "";
}

function stableSelectionId(idempotencyKey: string): string {
  return `tg_${createHash("sha256").update(`telegram-project-selection:${idempotencyKey}`).digest("base64url").slice(0, 22)}`;
}
