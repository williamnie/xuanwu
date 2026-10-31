import type { RunnerDatabase } from "../../db/database.ts";
import { consumeImProjectSelection } from "../../db/repositories/imProjectSelections.ts";
import { ingestPiGuardianEvent } from "../../pi/guardian/guardianEventIngest.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import { resolveImActionTarget } from "../im/imActionTarget.ts";
import { buildImConversationPromptProjection } from "../im/imConversationContext.ts";
import { type ImConversationRoute } from "../im/imConversationRouting.ts";
import { deliverImOutboundNow } from "../im/imOutboundDelivery.ts";
import { type ImProjectContextResult } from "../im/imProjectContext.ts";
import { createTelegramImOutboundEnvelope } from "./telegramChannelConnector.ts";
import { notificationPresentation } from "../../notifications/notificationPresentation.ts";
import type { Options, BridgeInput, RunResult } from "./telegramAgentBridge.model.ts";

export async function runConversation(
  options: Options,
  input: BridgeInput,
  route: ImConversationRoute,
  projectContext: ImProjectContextResult
): Promise<RunResult> {
  const resolvedProject = projectContext.status === "resolved" ? projectContext.projectId : "";
  if (route.isNewCommand && route.prompt === "") {
    return { kind: "reply", projectContext, route, targetProjectId: resolvedProject, text: newConversationText(options.database) };
  }
  if (projectContext.status === "ambiguous") {
    return { kind: "selection", projectContext, route, text: projectSelectionText(options.database) };
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
    const projection = buildImConversationPromptProjection(options.database, {
        conversation: {
          connectorId: "telegram",
          conversationId: input.normalized.message.conversation.id,
          currentMessageId: input.normalized.message.message_id,
          piConversationId: route.conversationId,
          threadId: input.normalized.message.thread?.id ?? ""
        }
      });
    const result = await options.runSupervisorConversation({
      channelContext: projection.prompt,
      channelContextProjection: projection,
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
    return { kind: "reply", projectContext, route, text: bridgeErrorText(options.database, message) };
  }
}

export async function resolveProjectSelection(options: Options, input: {
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
  await sendStandaloneText(
    options,
    selection.chat_id,
    projectSelectedText(options.database, input.projectId),
    `${input.callbackId}:selected`,
    input.threadId
  );
  if (!options.runSupervisorConversation) return { ok: true, status: "project_selection_saved" };
  try {
    const projection = buildImConversationPromptProjection(options.database, {
        conversation: {
          connectorId: "telegram",
          conversationId: selection.chat_id,
          currentMessageId: selection.source_message_id,
          piConversationId: selection.conversation_id,
          threadId: input.threadId
        }
      });
    const reply = await options.runSupervisorConversation({
      channelContext: projection.prompt,
      channelContextProjection: projection,
      conversationId: selection.conversation_id,
      prompt: selection.original_prompt,
      targetProjectId: input.projectId,
      targetProjectSource: "interaction_select",
      title: `Telegram · ${selection.chat_id}`
    });
    if (reply.text.trim()) await sendStandaloneText(options, selection.chat_id, reply.text, `${input.callbackId}:continued`, input.threadId);
    return { ok: true, status: "project_selection_continued" };
  } catch (error) {
    await sendStandaloneText(
      options,
      selection.chat_id,
      projectSelectionErrorText(options.database, input.projectId, safeError(error)),
      `${input.callbackId}:failed`,
      input.threadId
    );
    return { ok: false, status: "project_selection_continue_failed" };
  }
}

export function newConversationText(db: RunnerDatabase): string {
  const presentation = notificationPresentation(db);
  return presentation.language === "en-US"
    ? `${presentation.display_name}: A fresh conversation is ready. Send the next message when you are ready.`
    : `${presentation.display_name}：新会话准备好了，继续发消息就行。`;
}

export function projectSelectionText(db: RunnerDatabase): string {
  const presentation = notificationPresentation(db);
  return presentation.language === "en-US"
    ? `${presentation.display_name}: Choose the project for this request.`
    : `${presentation.display_name}：请选择这条请求对应的项目。`;
}

export function bridgeErrorText(db: RunnerDatabase, error: string): string {
  const presentation = notificationPresentation(db);
  return presentation.language === "en-US"
    ? `${presentation.display_name} could not hand this request to Runner: ${error}. Try again later, or include the project name and goal.`
    : `${presentation.display_name} 暂时没接住这条请求：${error}。你可以稍后重试；如果目标不明确，补上项目名和要做的事。`;
}

export function projectSelectedText(db: RunnerDatabase, projectID: string): string {
  const presentation = notificationPresentation(db);
  return presentation.language === "en-US"
    ? `${presentation.display_name}: I will use ${projectID} for your previous request.`
    : `${presentation.display_name}：已选择 ${projectID}，我会用它处理刚才的请求。`;
}

export function projectSelectionErrorText(db: RunnerDatabase, projectID: string, error: string): string {
  const presentation = notificationPresentation(db);
  return presentation.language === "en-US"
    ? `${presentation.display_name}: ${projectID} was selected, but I could not continue: ${error}.`
    : `${presentation.display_name}：已选择 ${projectID}，但继续处理时出错：${error}。`;
}

export async function sendStandaloneText(options: Options, chatId: string, text: string, key: string, threadId = ""): Promise<void> {
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

export function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error))
    .replace(/(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g, "[redacted-path]");
}

export function id(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return typeof value === "string" ? value.trim() : "";
}
