import type { RunnerDatabase } from "../db/database.ts";
import { getImInteractionBinding, type ImInteractionBinding } from "../db/repositories/imInteractionBindings.ts";
import type { EventBus } from "../events/bus.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { resolvePiApprovalRequestFromIm } from "./imApprovalResolve.ts";
import { createImInteractionService, type ImInteractionHandleResult } from "./imInteractionService.ts";
import { resolvePiActionFromIm } from "./imPiActionResolve.ts";
import { imConversationScopeKey } from "./imConversationRouting.ts";
import { decodeTelegramCallbackData } from "./telegramCallbackCodec.ts";
import type { TelegramBotClient } from "./telegramClient.ts";
import type { TelegramCallbackQuery, TelegramConnectorConfig } from "./telegramTypes.ts";

export type TelegramProjectSelectionResolver = (input: {
  callbackId: string;
  chatId: string;
  messageId: string;
  projectId: string;
  selectionId: string;
  threadId: string;
  userId: string;
}) => Promise<{ ok: boolean; status: string }>;

export type TelegramInteractionResultPresenter = (input: {
  callbackId: string;
  chatId: string;
  text: string;
  threadId: string;
}) => Promise<void> | void;

export async function resolveTelegramInteraction(input: {
  bus?: EventBus;
  callback: TelegramCallbackQuery;
  client: TelegramBotClient;
  config: TelegramConnectorConfig;
  database: RunnerDatabase;
  presentResult?: TelegramInteractionResultPresenter;
  projectSelection?: TelegramProjectSelectionResolver;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
}): Promise<ImInteractionHandleResult> {
  const parsed = decodeTelegramCallbackData(input.callback.data);
  const chatId = telegramId(input.callback.message?.chat.id, true);
  const threadId = telegramId(input.callback.message?.message_thread_id, false);
  const userId = telegramId(input.callback.from.id, false);
  if (!parsed || chatId === "" || userId === "") {
    await safeAnswer(input.client, input.callback.id, "这个操作无效，请从最新消息重试。", true);
    return { reason: "missing_binding" };
  }
  const binding = getImInteractionBinding(input.database, parsed.interactionId);
  const action = binding?.actions[parsed.actionIndex];
  if (!binding || !action) {
    await safeAnswer(input.client, input.callback.id, "这个操作已失效，请从最新消息重试。", true);
    return { reason: "missing_binding" };
  }
  if (!callbackAllowed(input.config, chatId, userId)) {
    await safeAnswer(input.client, input.callback.id, "你没有权限执行这个操作。", true);
    return { reason: "actor_mismatch" };
  }
  const scopeKey = binding.action_kind === "project_selection"
    ? imConversationScopeKey({
      connectorId: "telegram",
      conversationId: chatId,
      messageId: telegramId(input.callback.message?.message_id, false),
      threadId
    })
    : chatId;
  const preflight = bindingFailure(binding, parsed.revision, scopeKey, userId);
  if (preflight) {
    await safeAnswer(input.client, input.callback.id, resultText(preflight), true);
    if (preflight === "already_consumed") await safeClearMarkup(input.client, chatId, input.callback);
    return { reason: preflight };
  }
  const service = createImInteractionService({
    database: input.database,
    resolvers: {
      approval: ({ action, binding: current }) => {
        const [decision, scope = "turn"] = action.value.split(":", 2);
        return resolvePiApprovalRequestFromIm(input.database, {
          decision,
          providers: input.providers,
          requestID: refId(current.action_ref, "pi_approval_requests"),
          scope
        });
      },
      piAction: ({ action, binding: current }) => {
        const [decision, minutes] = action.value.split(":", 2);
        return resolvePiActionFromIm({ bus: input.bus, database: input.database, providers: input.providers }, {
          actionID: input.callback.id,
          actor: `telegram:${userId}`,
          connectorID: "telegram",
          conversationID: chatId,
          decision: decision as "approve" | "approve_always" | "reject" | "request_changes" | "snooze",
          piActionID: refId(current.action_ref, "pi_actions"),
          snoozeMinutes: positiveInteger(minutes) || undefined
        });
      },
      projectSelection: input.projectSelection ? ({ action, binding: current }) => input.projectSelection!({
        callbackId: input.callback.id,
        chatId,
        messageId: telegramId(input.callback.message?.message_id, false),
        projectId: action.value,
        selectionId: refId(current.action_ref, "im_project_selections"),
        threadId,
        userId
      }) : undefined
    }
  });
  await safeAnswer(input.client, input.callback.id, "正在处理…", false);
  const result = await service.handle({
    actionId: action.action_id,
    actor: { id: userId },
    connectorId: "telegram",
    eventId: input.callback.id,
    interactionId: parsed.interactionId,
    revision: parsed.revision,
    scopeKey
  });
  if (result.reason === "consumed" || result.reason === "already_consumed") {
    await safeClearMarkup(input.client, chatId, input.callback);
  }
  if (binding.action_kind !== "project_selection" || result.reason !== "consumed") {
    await safePresentResult(input.presentResult, input.callback.id, chatId, threadId, result);
  }
  return result;
}

function callbackAllowed(config: TelegramConnectorConfig, chatId: string, userId: string): boolean {
  return config.allowedChatIds.includes(chatId) && config.allowedUserIds.includes(userId);
}

async function safeAnswer(client: TelegramBotClient, callbackQueryId: string, text: string, showAlert: boolean): Promise<void> {
  try {
    await client.answerCallbackQuery({ callbackQueryId, showAlert, text });
  } catch {
    // The business transition is authoritative; Telegram's short-lived UI ack is best effort.
  }
}

async function safeClearMarkup(client: TelegramBotClient, chatId: string, callback: TelegramCallbackQuery): Promise<void> {
  try {
    await client.editMessageReplyMarkup({
      chatId,
      ...(callback.inline_message_id ? { inlineMessageId: callback.inline_message_id } : {}),
      ...(callback.message ? { messageId: telegramId(callback.message.message_id, false) } : {})
    });
  } catch {
    // A consumed binding prevents duplicate execution even if the old keyboard stays visible.
  }
}

async function safePresentResult(
  present: TelegramInteractionResultPresenter | undefined,
  callbackId: string,
  chatId: string,
  threadId: string,
  result: ImInteractionHandleResult
): Promise<void> {
  if (!present) return;
  const status = result.resolution?.status?.trim().slice(0, 160) ?? "";
  const text = result.reason === "consumed"
    ? result.resolution?.ok === false
      ? `操作未执行${status ? `：${status}` : "。"}`
      : `操作已处理${status ? `：${status}` : "。"}`
    : resultText(result.reason);
  try {
    await present({ callbackId, chatId, text, threadId });
  } catch {
    // Binding state remains authoritative if the final presentation fails.
  }
}

function bindingFailure(
  binding: ImInteractionBinding,
  revision: number,
  scopeKey: string,
  userId: string,
  now = new Date()
): ImInteractionHandleResult["reason"] | "" {
  if (binding.connector_id !== "telegram" || binding.scope_key !== scopeKey) return "source_mismatch";
  if ((binding.actor_id && binding.actor_id !== userId) ||
      (!binding.actor_id && binding.actor_open_id !== userId)) return "actor_mismatch";
  if (binding.revision !== revision) return "revision_mismatch";
  if (binding.status === "consumed") return "already_consumed";
  const expiresAt = Date.parse(binding.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) return "expired";
  return "";
}

function resultText(reason: ImInteractionHandleResult["reason"]): string {
  if (reason === "consumed") return "操作已处理。";
  if (reason === "expired") return "这个操作已过期，请从最新消息重试。";
  if (reason === "already_consumed") return "这个操作已经处理过了。";
  if (reason === "resolution_in_progress") return "这个操作正在处理中。";
  if (reason === "actor_mismatch" || reason === "source_mismatch") return "这个操作不属于当前用户或会话。";
  return "这个操作无法处理，请从最新消息重试。";
}

function refId(value: string, prefix: string): string {
  const marker = `${prefix}:`;
  if (!value.startsWith(marker) || value.slice(marker.length).trim() === "") throw new Error(`invalid ${prefix} action reference`);
  return value.slice(marker.length).trim();
}

function positiveInteger(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function telegramId(value: unknown, allowNegative: boolean): string {
  const text = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string" ? value.trim() : "";
  if (!/^-?[1-9]\d*$/.test(text)) return "";
  const number = Number(text);
  return Number.isSafeInteger(number) && (allowNegative || number > 0) ? text : "";
}
