import { createHash } from "node:crypto";
import { decidePiAttention, type PiAttentionDecision } from "../pi/attentionRouter.ts";
import { listProjects } from "../db/repositories/projects.ts";
import type { RunnerDatabase } from "../db/database.ts";
import {
  IM_MESSAGE_SCHEMA_VERSION,
  type ImInboundMessageV1
} from "./imChannelContracts.ts";
import {
  validateInboundEnvelope,
  type InboundEnvelope
} from "./channelConnectorContracts.ts";
import { telegramChannelConnectorManifest, TELEGRAM_CONNECTOR_ID } from "./telegramChannelConnector.ts";
import type {
  TelegramBotIdentity,
  TelegramConnectorConfig,
  TelegramFile,
  TelegramMessage,
  TelegramMessageEntity,
  TelegramUpdate
} from "./telegramTypes.ts";

export type TelegramNormalizedMessage = {
  attention: PiAttentionDecision;
  envelope: InboundEnvelope;
  message: ImInboundMessageV1;
  prompt: string;
};

export function normalizeTelegramMessageUpdate(input: {
  bot: TelegramBotIdentity;
  config: TelegramConnectorConfig;
  database?: RunnerDatabase;
  edited?: boolean;
  update: TelegramUpdate;
}): TelegramNormalizedMessage {
  const source = input.edited ? input.update.edited_message : input.update.message;
  if (!source) throw permanent("telegram update does not contain a message");
  const message = telegramImInboundMessage(input.update.update_id, source, input.bot);
  if (message.sender.kind === "bot" || message.sender.id === telegramNumericId(input.bot.id, "bot id", false)) {
    throw permanent("telegram bot-authored message is ignored");
  }
  if (message.sender.kind === "unknown") throw permanent("telegram message sender is unknown");
  const attention = telegramSourceAllowed(message, input.config) ? decidePiAttention({
    message: {
      attachments: message.attachments,
      chat_id: message.conversation.id,
      mentions: message.mentions.map((item) => ({ id: item.id, name: item.is_self ? "bot" : item.display_name })),
      message_id: message.message_id,
      sender_id: message.sender.id,
      text: message.text
    },
    policy: input.config,
    projects: input.database ? listProjects(input.database).map((item) => ({ id: item.id, name: item.name })) : []
  }) : unauthorizedAttention(message);
  const envelope = telegramInboundEnvelope(input.update.update_id, message);
  return { attention, envelope, message, prompt: telegramPrompt(message.text, input.bot.username) };
}

export function telegramImInboundMessage(
  updateId: number,
  source: TelegramMessage,
  bot: TelegramBotIdentity
): ImInboundMessageV1 {
  const text = boundedMessageText(source.text ?? source.caption ?? "");
  const entities = source.text ? source.entities ?? [] : source.caption_entities ?? [];
  const sender = source.from ? {
    id: telegramNumericId(source.from.id, "sender id", false),
    display_name: [source.from.first_name, source.from.last_name].map(clean).filter(Boolean).join(" ") || clean(source.from.username),
    kind: source.from.is_bot ? "bot" as const : "user" as const
  } : source.sender_chat ? {
    id: telegramNumericId(source.sender_chat.id, "sender chat id", true),
    display_name: clean(source.sender_chat.title) || clean(source.sender_chat.username),
    kind: "chat" as const
  } : { id: "unknown", kind: "unknown" as const };
  const chatId = telegramNumericId(source.chat.id, "chat id", true);
  const messageId = telegramNumericId(source.message_id, "message id", false);
  const threadId = source.message_thread_id === undefined ? "" : telegramNumericId(source.message_thread_id, "message thread id", false);
  return {
    attachments: attachments(source),
    connector_id: TELEGRAM_CONNECTOR_ID,
    conversation: { id: chatId, kind: conversationKind(source.chat.type) },
    mentions: mentions(text, entities, bot),
    message_id: messageId,
    occurred_at: new Date(validUnixSeconds(source.date) * 1000).toISOString(),
    raw_event_ref: telegramRawEventRef({ update_id: updateId, message: source }),
    schema_version: IM_MESSAGE_SCHEMA_VERSION,
    sender,
    text,
    ...(threadId ? { thread: { id: threadId } } : {}),
    update_id: telegramNumericId(updateId, "update id", false, true)
  };
}

export function telegramInboundEnvelope(updateId: number, message: ImInboundMessageV1): InboundEnvelope {
  const eventId = `telegram:message:${message.conversation.id}:${message.message_id}`;
  const dedupe = `telegram:update:${updateId}`;
  const envelope: InboundEnvelope = {
    audit: {
      action_id: `telegram-inbound:${updateId}`,
      correlation_id: eventId,
      event_ref: message.raw_event_ref,
      idempotency_key: dedupe,
      occurred_at: message.occurred_at
    },
    connector_id: TELEGRAM_CONNECTOR_ID,
    cursor: { connector_id: TELEGRAM_CONNECTOR_ID, position: telegramNumericId(updateId, "update id", false, true), scope: "bot-updates" },
    event_id: eventId,
    event_type: "message.receive",
    occurred_at: message.occurred_at,
    payload: message as unknown as Record<string, unknown>,
    source: TELEGRAM_CONNECTOR_ID
  };
  const validation = validateInboundEnvelope(envelope, telegramChannelConnectorManifest());
  if (!validation.ok) throw permanent(`invalid Telegram inbound envelope: ${validation.errors.join("; ")}`);
  return envelope;
}

export function telegramRawEventRef(value: unknown): string {
  let payload = "";
  try {
    payload = JSON.stringify(value) ?? "";
  } catch {
    payload = String(value);
  }
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

export function telegramPrompt(text: string, botUsername?: string): string {
  let prompt = clean(text);
  const username = clean(botUsername).replace(/^@/, "");
  if (username) {
    prompt = prompt.replace(new RegExp(`^/(new)(?:@${escapeRegExp(username)})?(?=\\s|$)`, "i"), "/$1");
    prompt = prompt.replace(new RegExp(`^@${escapeRegExp(username)}(?:[:,]?\\s*)`, "i"), "");
  }
  return prompt.trim();
}

function mentions(text: string, entities: TelegramMessageEntity[], bot: TelegramBotIdentity) {
  const botId = telegramNumericId(bot.id, "bot id", false);
  const username = clean(bot.username).toLowerCase().replace(/^@/, "");
  return entities.flatMap((entity) => {
    if (!Number.isInteger(entity.offset) || !Number.isInteger(entity.length) || entity.offset < 0 || entity.length <= 0) return [];
    const visible = text.slice(entity.offset, entity.offset + entity.length);
    if (entity.type === "text_mention" && entity.user) {
      const mentionedId = telegramNumericId(entity.user.id, "mentioned user id", false);
      return [{ id: mentionedId, display_name: visible.slice(0, 512), is_self: mentionedId === botId }];
    }
    if (entity.type !== "mention" && entity.type !== "bot_command") return [];
    const handle = visible.replace(/^[@/]/, "").split("@").pop()?.toLowerCase() ?? "";
    return [{ display_name: visible.slice(0, 512), is_self: username !== "" && handle === username }];
  }).slice(0, 64);
}

function attachments(message: TelegramMessage): ImInboundMessageV1["attachments"] {
  const result: ImInboundMessageV1["attachments"] = [];
  pushFile(result, message.document, "file");
  pushFile(result, message.audio, "audio");
  pushFile(result, message.video, "video");
  const photo = message.photo?.at(-1);
  if (photo?.file_id) {
    result.push({
      id: boundedMetadata(photo.file_id, "photo file id", 512),
      kind: "image",
      ...optionalSize(photo.file_size)
    });
  }
  return result.slice(0, 16);
}

function pushFile(target: ImInboundMessageV1["attachments"], file: TelegramFile | undefined, kind: "audio" | "file" | "video"): void {
  if (!file?.file_id) return;
  target.push({
    id: boundedMetadata(file.file_id, `${kind} file id`, 512),
    kind,
    ...(clean(file.file_name) ? { name: clean(file.file_name).slice(0, 512) } : {}),
    ...(clean(file.mime_type) ? { mime_type: clean(file.mime_type).slice(0, 256) } : {}),
    ...optionalSize(file.file_size)
  });
}

function conversationKind(value: string): ImInboundMessageV1["conversation"]["kind"] {
  if (value === "private") return "direct";
  if (value === "group" || value === "supergroup") return "group";
  if (value === "channel") return "channel";
  return "unknown";
}

function telegramSourceAllowed(message: ImInboundMessageV1, config: TelegramConnectorConfig): boolean {
  if (!config.allowedChatIds.includes(message.conversation.id)) return false;
  return message.sender.kind === "chat" ||
    (message.sender.kind === "user" && config.allowedUserIds.includes(message.sender.id));
}

function unauthorizedAttention(message: ImInboundMessageV1): PiAttentionDecision {
  return {
    decision: "ignore",
    evidence: [{
      kind: "policy",
      reason: "telegram_source_not_allowed",
      value: `${message.conversation.id}:${message.sender.id}`
    }],
    needs_project: false,
    project_id: "",
    project_source: "none",
    reason: "telegram_source_not_allowed",
    should_create_issue_proposal: false,
    signals: []
  };
}

function validUnixSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 253_402_300_799) {
    throw permanent("telegram message date is invalid");
  }
  return value;
}

function boundedMessageText(value: unknown): string {
  const text = clean(value);
  if ([...text].length > 30_000) throw permanent("telegram message text exceeds 30000 characters");
  return text;
}

function boundedMetadata(value: unknown, label: string, maximum: number): string {
  const text = clean(value);
  if (text === "" || text.length > maximum) throw permanent(`telegram ${label} is invalid`);
  return text;
}

function optionalSize(value: unknown): { size_bytes?: number } {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? { size_bytes: value } : {};
}

function permanent(message: string): Error & { kind: "permanent" } {
  return Object.assign(new Error(message), { kind: "permanent" as const });
}

function telegramNumericId(value: unknown, label: string, allowNegative: boolean, allowZero = false): string {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : clean(value);
  if (!/^-?(?:0|[1-9]\d*)$/.test(text)) throw permanent(`telegram ${label} is invalid`);
  const number = Number(text);
  if (!Number.isSafeInteger(number) || (!allowZero && number === 0) || (!allowNegative && number < 0)) {
    throw permanent(`telegram ${label} is invalid`);
  }
  return text;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
