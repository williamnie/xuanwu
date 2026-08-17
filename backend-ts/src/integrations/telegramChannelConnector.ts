import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../db/database.ts";
import {
  listConnectorDeliveryParts,
  saveConnectorDeliveryPart
} from "../db/repositories/connectorRuntime.ts";
import {
  CHANNEL_CONNECTOR_CONTRACT_VERSION,
  assertOutboundEnvelope,
  validateInboundEnvelope,
  type ChannelConnector,
  type ConnectorDeliveryReceipt,
  type ConnectorHealth,
  type ConnectorManifest,
  type OutboundEnvelope
} from "./channelConnectorContracts.ts";
import {
  IM_OUTBOUND_SCHEMA_VERSION,
  createImOutboundEnvelope,
  imOutboundPayloadFromEnvelope,
  imTargetUri,
  type ImInteractionV1,
  type ImOutboundPayloadV1,
  type ImTargetV1
} from "./imChannelContracts.ts";
import { encodeTelegramCallbackData } from "./telegramCallbackCodec.ts";
import { createTelegramBotClient, TelegramClientError, type TelegramBotClient, type TelegramInlineKeyboard } from "./telegramClient.ts";
import { telegramConnectorStatus } from "./telegramConfig.ts";
import type { TelegramConnectorConfig } from "./telegramTypes.ts";

export const TELEGRAM_CONNECTOR_ID = "telegram" as const;
export const TELEGRAM_MESSAGE_LIMIT = 4096;

type Options = {
  config: TelegramConnectorConfig | (() => TelegramConnectorConfig);
  database: RunnerDatabase;
  health?: () => ConnectorHealth;
  now?: () => number;
  onInbound?: ChannelConnector["ingest"];
  sender?: TelegramBotClient;
};

export function telegramChannelConnectorManifest(authRefs: string[] = []): ConnectorManifest {
  return {
    auth_refs: [...new Set(authRefs.map(clean).filter(Boolean))].map((ref) => ({ kind: "secret_ref", ref })),
    capabilities: [
      { id: "message.receive", kind: "inbound", requires_authorization: true },
      { id: "message.reply", kind: "outbound", requires_authorization: true },
      { id: "reaction.add", kind: "outbound", requires_authorization: true },
      { id: "interaction.send", kind: "outbound", requires_authorization: true },
      { id: "interaction.receive", kind: "inbound", requires_authorization: true },
      { id: "thread.reply", kind: "outbound", requires_authorization: true }
    ],
    contract_version: CHANNEL_CONNECTOR_CONTRACT_VERSION,
    display_name: "Telegram IM",
    id: TELEGRAM_CONNECTOR_ID,
    kind: "channel"
  };
}

export function createTelegramChannelConnector(options: Options): ChannelConnector {
  const manifest = telegramChannelConnectorManifest();
  const queues = new Map<string, Promise<unknown>>();
  const cooldowns = new Map<string, number>();
  return {
    manifest,
    health: () => options.health?.() ?? configHealth(config(options.config)),
    ingest: (envelope) => {
      const validation = validateInboundEnvelope(envelope, manifest);
      if (!validation.ok) throw new Error(`invalid Telegram inbound envelope: ${validation.errors.join("; ")}`);
      return options.onInbound?.(envelope);
    },
    deliver: (envelope) => enqueueDelivery(
      queues,
      cooldowns,
      deliveryQueueKey(envelope),
      options.now ?? Date.now,
      () => deliverTelegram(options, manifest, envelope)
    )
  };
}

function enqueueDelivery<T>(
  queues: Map<string, Promise<unknown>>,
  cooldowns: Map<string, number>,
  key: string,
  now: () => number,
  work: () => Promise<T>
): Promise<T> {
  const prior = queues.get(key) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(async () => {
    const retryAt = cooldowns.get(key) ?? 0;
    const remaining = Math.ceil((retryAt - now()) / 1000);
    if (remaining > 0) {
      throw new TelegramClientError("Telegram chat delivery is rate limited", {
        kind: "rate_limited",
        retryAfterSeconds: remaining,
        status: 429
      });
    }
    if (retryAt > 0) cooldowns.delete(key);
    try {
      return await work();
    } catch (error) {
      if (error instanceof TelegramClientError && error.kind === "rate_limited" && error.retryAfterSeconds) {
        cooldowns.set(key, Math.max(cooldowns.get(key) ?? 0, now() + error.retryAfterSeconds * 1000));
      }
      throw error;
    }
  });
  queues.set(key, next);
  void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
  return next;
}

function deliveryQueueKey(envelope: OutboundEnvelope): string {
  try {
    return imOutboundPayloadFromEnvelope(envelope).target.conversation_id || "unknown";
  } catch {
    return "invalid";
  }
}

export function telegramConnectorTarget(chatId: string): string {
  return imTargetUri({ connector_id: TELEGRAM_CONNECTOR_ID, conversation_id: required(chatId, "chat id") }, "chat_id");
}

export function createTelegramImOutboundEnvelope(input: {
  actionGateRef: string;
  actionID: string;
  authority: "deterministic_policy" | "human_approval";
  correlationID: string;
  eventRef: string;
  idempotencyKey: string;
  occurredAt?: string;
  operation: "message.reply" | "reaction.add";
  reaction?: string;
  target: ImTargetV1;
  text?: string;
}): OutboundEnvelope {
  if (input.target.connector_id !== TELEGRAM_CONNECTOR_ID) throw new Error("Telegram target connector is invalid");
  const payload: ImOutboundPayloadV1 = input.operation === "reaction.add" ? {
    operation: "reaction.add",
    reaction: required(input.reaction, "reaction"),
    schema_version: IM_OUTBOUND_SCHEMA_VERSION,
    target: input.target
  } : {
    operation: "message.reply",
    schema_version: IM_OUTBOUND_SCHEMA_VERSION,
    target: input.target,
    text: required(input.text, "text")
  };
  return createImOutboundEnvelope({ ...input, payload, target: telegramConnectorTarget(input.target.conversation_id) });
}

async function deliverTelegram(options: Options, manifest: ConnectorManifest, envelope: OutboundEnvelope): Promise<ConnectorDeliveryReceipt> {
  assertOutboundEnvelope(envelope, manifest);
  if (!manifest.capabilities.some((item) => item.kind === "outbound" && item.id === envelope.operation)) {
    throw new TelegramClientError("Telegram outbound operation is not declared", { kind: "permanent" });
  }
  const payload = imOutboundPayloadFromEnvelope(envelope);
  const target = payload.target;
  const current = config(options.config);
  assertAllowedTarget(current, target);
  const sender = options.sender ?? createTelegramBotClient({ config: current });
  if (payload.operation === "reaction.add") {
    const messageId = required(target.reply_to_message_id, "reaction message id");
    await sender.setMessageReaction({ chatId: target.conversation_id, messageId, reaction: required(payload.reaction, "reaction") });
    return { provider_request_ref: `reaction:${target.conversation_id}:${messageId}`, replayed: false, target: envelope.target };
  }
  const text = payload.operation === "interaction.send"
    ? renderInteractionText(payload.interaction!, payload.fallback_text)
    : required(payload.text, "message text");
  const keyboard = payload.operation === "interaction.send" ? renderKeyboard(payload.interaction!) : undefined;
  return sendParts(options.database, sender, envelope, target, text, keyboard);
}

async function sendParts(
  db: RunnerDatabase,
  sender: TelegramBotClient,
  envelope: OutboundEnvelope,
  target: ImTargetV1,
  text: string,
  keyboard?: TelegramInlineKeyboard
): Promise<ConnectorDeliveryReceipt> {
  const parts = splitTelegramText(text);
  const durable = listConnectorDeliveryParts(db, TELEGRAM_CONNECTOR_ID, envelope.idempotency_key);
  const refs: string[] = [];
  for (const [index, part] of parts.entries()) {
    const hash = createHash("sha256").update(part).digest("hex");
    const existing = durable.find((item) => item.part_index === index);
    if (existing) {
      if (existing.part_count !== parts.length || existing.content_hash !== hash) {
        throw new TelegramClientError("Telegram durable message split does not match retry", { kind: "permanent" });
      }
      refs.push(existing.provider_request_ref);
      continue;
    }
    const sent = await sender.sendMessage({
      chatId: target.conversation_id,
      ...(target.thread_id ? { messageThreadId: target.thread_id } : {}),
      ...(index === 0 && target.reply_to_message_id ? { replyToMessageId: target.reply_to_message_id } : {}),
      ...(index === parts.length - 1 && keyboard ? { replyMarkup: keyboard } : {}),
      text: part
    });
    const ref = String(sent.message_id);
    saveConnectorDeliveryPart(db, {
      connectorId: TELEGRAM_CONNECTOR_ID,
      content_hash: hash,
      idempotency_key: envelope.idempotency_key,
      part_count: parts.length,
      part_index: index,
      provider_request_ref: ref
    });
    refs.push(ref);
  }
  const replayed = refs.length > 0 && durable.length === parts.length;
  return {
    provider_message_refs: refs,
    provider_request_ref: refs.at(-1)!,
    replayed,
    target: envelope.target
  };
}

function renderKeyboard(interaction: ImInteractionV1): TelegramInlineKeyboard {
  const rows = interaction.actions.map((action, index) => [{
    callback_data: encodeTelegramCallbackData({ actionIndex: index, interactionId: interaction.interaction_id, revision: interaction.revision }),
    text: action.label.slice(0, 64)
  }]);
  return { inline_keyboard: rows };
}

function renderInteractionText(interaction: ImInteractionV1, fallback?: string): string {
  return [interaction.title, interaction.body || clean(fallback)].filter(Boolean).join("\n\n");
}

export function splitTelegramText(value: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  const characters = [...required(value, "message text")];
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("Telegram message limit is invalid");
  const parts: string[] = [];
  let offset = 0;
  while (offset < characters.length) {
    const end = Math.min(offset + limit, characters.length);
    if (end === characters.length) {
      parts.push(characters.slice(offset).join(""));
      break;
    }
    const candidate = characters.slice(offset, end).join("");
    const paragraphBreak = candidate.lastIndexOf("\n\n");
    const take = paragraphBreak > 0 ? [...candidate.slice(0, paragraphBreak + 2)].length : end - offset;
    parts.push(characters.slice(offset, offset + take).join(""));
    offset += take;
  }
  return parts;
}

function assertAllowedTarget(config: TelegramConnectorConfig, target: ImTargetV1): void {
  if (target.connector_id !== TELEGRAM_CONNECTOR_ID) throw new TelegramClientError("Telegram target connector is invalid", { kind: "permanent" });
  const chatId = required(target.conversation_id, "chat id");
  if (!config.enabled) throw new TelegramClientError("Telegram connector is disabled", { kind: "permanent" });
  if (config.allowedChatIds.length === 0 || !config.allowedChatIds.includes(chatId)) {
    throw new TelegramClientError("Telegram chat target is not allowed", { kind: "permanent" });
  }
}

function config(value: Options["config"]): TelegramConnectorConfig {
  return typeof value === "function" ? value() : value;
}

function configHealth(value: TelegramConnectorConfig): ConnectorHealth {
  const status = telegramConnectorStatus(value);
  return {
    checked_at: new Date().toISOString(),
    last_error: status.missing_required.join(", "),
    reconnect_attempts: 0,
    state: status.status === "disabled" ? "disabled" : status.status === "configured" ? "healthy" : "failed"
  };
}

function required(value: unknown, label: string): string {
  const result = clean(value);
  if (!result) throw new TelegramClientError(`${label} is required`, { kind: "permanent" });
  return result;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}
