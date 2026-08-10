import type { FeishuConnectorConfig, FeishuNormalizedMessageEvent } from "./feishuTypes.ts";
import { feishuConnectorStatus } from "./feishuConfig.ts";
import { normalizeFeishuMessageEvent } from "./feishuEvents.ts";
import {
  CHANNEL_CONNECTOR_CONTRACT_VERSION,
  assertOutboundEnvelope,
  validateInboundEnvelope,
  type ChannelConnector,
  type ConnectorDeliveryReceipt,
  type ConnectorHealth,
  type ConnectorManifest,
  type InboundEnvelope,
  type OutboundEnvelope
} from "./channelConnectorContracts.ts";
import {
  createFeishuMessageClient,
  FeishuClientError,
  type FeishuMessageClient
} from "./feishuClient.ts";
import {
  IM_MESSAGE_SCHEMA_VERSION,
  IM_OUTBOUND_SCHEMA_VERSION,
  createImOutboundEnvelope,
  imOutboundPayloadFromEnvelope,
  type ImInboundMessageV1
} from "./imChannelContracts.ts";

export const FEISHU_CONNECTOR_ID = "feishu" as const;

export type FeishuConnectorInbound = {
  envelope: InboundEnvelope;
  event: FeishuNormalizedMessageEvent;
};

type FeishuConnectorOptions = {
  config: FeishuConnectorConfig | (() => FeishuConnectorConfig);
  health?: () => ConnectorHealth;
  onInbound?: (envelope: InboundEnvelope) => Promise<void> | void;
  sender?: FeishuMessageClient;
};

export function feishuChannelConnectorManifest(authRefs: string[] = []): ConnectorManifest {
  return {
    auth_refs: [...new Set(authRefs.map(cleanString).filter(Boolean))].map((ref) => ({ kind: "secret_ref", ref })),
    capabilities: [
      { id: "message.receive", kind: "inbound", requires_authorization: true },
      { id: "message.reply", kind: "outbound", requires_authorization: true },
      { id: "reaction.add", kind: "outbound", requires_authorization: true },
      { id: "interaction.send", kind: "outbound", requires_authorization: true },
      { id: "interaction.receive", kind: "inbound", requires_authorization: true },
      { id: "thread.reply", kind: "outbound", requires_authorization: true },
      // W1 compatibility capability: pre-cutover interactive cards already
      // delivered to chats still resolve through the bounded compat window.
      { id: "card.send", kind: "outbound", requires_authorization: true }
    ],
    contract_version: CHANNEL_CONNECTOR_CONTRACT_VERSION,
    display_name: "Feishu IM",
    id: FEISHU_CONNECTOR_ID,
    kind: "channel"
  };
}

export function normalizeFeishuInboundEnvelope(
  raw: unknown,
  options: { projectId?: string; rawPayloadRef?: string } = {}
): FeishuConnectorInbound {
  const event = normalizeFeishuMessageEvent(raw, { rawEventRef: options.rawPayloadRef });
  return { envelope: feishuInboundEnvelopeForEvent(event, options.projectId), event };
}

export function feishuInboundEnvelopeForEvent(
  event: FeishuNormalizedMessageEvent,
  projectId?: string
): InboundEnvelope {
  const projectHint = cleanString(projectId);
  const eventRef = cleanString(event.raw_event_ref) || event.source_id;
  const envelope: InboundEnvelope = {
    audit: {
      action_id: `feishu-inbound:${event.message_id}`,
      correlation_id: event.source_id,
      event_ref: eventRef,
      idempotency_key: event.dedupe_key,
      occurred_at: event.timestamp
    },
    connector_id: FEISHU_CONNECTOR_ID,
    cursor: {
      connector_id: FEISHU_CONNECTOR_ID,
      position: event.message_id,
      scope: inboundScope(event)
    },
    event_id: event.source_id,
    event_type: "message.receive",
    occurred_at: event.timestamp,
    payload: {
      ...feishuImInboundMessage(event),
      ...(projectHint === "" ? {} : { project_hint: projectHint })
    },
    source: FEISHU_CONNECTOR_ID
  };
  const validation = validateInboundEnvelope(envelope, feishuChannelConnectorManifest());
  if (!validation.ok) throw new Error(`invalid Feishu inbound connector envelope: ${validation.errors.join("; ")}`);
  return envelope;
}

export function feishuImInboundMessage(event: FeishuNormalizedMessageEvent): ImInboundMessageV1 {
  const threadID = cleanString(event.thread_id) || cleanString(event.root_id);
  return {
    attachments: event.attachments.map((item) => ({
      id: item.file_key || item.name,
      kind: imAttachmentKind(item.type),
      ...(item.mime_type ? { mime_type: item.mime_type } : {}),
      ...(item.name ? { name: item.name } : {}),
      ...(item.size > 0 ? { size_bytes: item.size } : {})
    })),
    connector_id: FEISHU_CONNECTOR_ID,
    conversation: { id: event.chat_id, kind: feishuConversationKind(event.chat_type) },
    mentions: event.mentions.map((item) => ({ id: item.id, display_name: item.name })),
    message_id: event.message_id,
    occurred_at: event.timestamp,
    raw_event_ref: cleanString(event.raw_event_ref) || event.source_id,
    schema_version: IM_MESSAGE_SCHEMA_VERSION,
    sender: {
      id: event.sender.id || event.sender.open_id,
      kind: feishuSenderKind(event.sender.type),
      ...(event.sender.open_id ? { open_id: event.sender.open_id } : {})
    },
    text: event.text,
    ...(threadID === "" ? {} : { thread: { id: threadID, ...(event.root_id ? { root_message_id: event.root_id } : {}) } }),
    update_id: event.source_id
  };
}

export function createFeishuOutboundEnvelope(input: {
  actionGateRef: string;
  actionID: string;
  authority: "deterministic_policy" | "human_approval";
  correlationID: string;
  eventRef: string;
  idempotencyKey: string;
  occurredAt?: string;
  operation: "card.send" | "message.reply" | "reaction.add";
  payload: Record<string, unknown>;
  receiveID: string;
  receiveIDType: string;
}): OutboundEnvelope {
  const occurredAt = cleanString(input.occurredAt) || new Date().toISOString();
  return {
    audit: {
      action_id: requiredText(input.actionID, "actionID"),
      correlation_id: requiredText(input.correlationID, "correlationID"),
      event_ref: requiredText(input.eventRef, "eventRef"),
      idempotency_key: requiredText(input.idempotencyKey, "idempotencyKey"),
      occurred_at: occurredAt
    },
    authorization: {
      action_gate_ref: requiredText(input.actionGateRef, "actionGateRef"),
      authority: input.authority,
      decision: "allow"
    },
    connector_id: FEISHU_CONNECTOR_ID,
    idempotency_key: requiredText(input.idempotencyKey, "idempotencyKey"),
    operation: input.operation,
    payload: input.payload,
    target: feishuConnectorTarget(input.receiveID, input.receiveIDType)
  };
}

/** Provider adapter helper that emits the canonical IM payload and preserves Feishu addressing metadata. */
export function createFeishuImOutboundEnvelope(input: {
  actionGateRef: string;
  actionID: string;
  authority: "deterministic_policy" | "human_approval";
  correlationID: string;
  eventRef: string;
  idempotencyKey: string;
  occurredAt?: string;
  operation: "message.reply" | "reaction.add";
  reaction?: string;
  receiveID: string;
  receiveIDType: string;
  replyToMessageID?: string;
  text?: string;
}): OutboundEnvelope {
  const target = {
    address_type: requiredText(input.receiveIDType, "receiveIDType"),
    connector_id: FEISHU_CONNECTOR_ID,
    conversation_id: requiredText(input.receiveID, "receiveID"),
    ...(cleanString(input.replyToMessageID) ? { reply_to_message_id: cleanString(input.replyToMessageID) } : {})
  };
  return createImOutboundEnvelope({
    actionGateRef: input.actionGateRef,
    actionID: input.actionID,
    authority: input.authority,
    correlationID: input.correlationID,
    eventRef: input.eventRef,
    idempotencyKey: input.idempotencyKey,
    occurredAt: input.occurredAt,
    payload: input.operation === "reaction.add"
      ? {
        operation: "reaction.add",
        reaction: requiredText(input.reaction, "reaction"),
        schema_version: IM_OUTBOUND_SCHEMA_VERSION,
        target
      }
      : {
        operation: "message.reply",
        schema_version: IM_OUTBOUND_SCHEMA_VERSION,
        target,
        text: requiredText(input.text, "text")
      },
    target: feishuConnectorTarget(input.receiveID, input.receiveIDType)
  });
}

export function migrateLegacyFeishuOutboxEnvelope(input: {
  approvalActionID?: string;
  card?: Record<string, unknown>;
  content: string;
  externalEventID?: number;
  id: number;
  issueID?: number;
  occurredAt?: string;
  replyDraftID: number;
  receiveID: string;
  receiveIDType: string;
}): OutboundEnvelope {
  const outboxRef = `sync_outbox:${positiveInteger(input.id, "id")}`;
  const draftRef = `im_reply_drafts:${positiveInteger(input.replyDraftID, "replyDraftID")}:approved`;
  const correlationID = input.externalEventID && input.externalEventID > 0
    ? `external_events:${input.externalEventID}`
    : input.issueID && input.issueID > 0 ? `issues:${input.issueID}` : outboxRef;
  return createFeishuOutboundEnvelope({
    actionGateRef: draftRef,
    actionID: cleanString(input.approvalActionID) || outboxRef,
    authority: "deterministic_policy",
    correlationID,
    eventRef: outboxRef,
    idempotencyKey: outboxRef,
    occurredAt: input.occurredAt,
    operation: input.card ? "card.send" : "message.reply",
    payload: input.card ? { card: input.card } : { text: input.content },
    receiveID: input.receiveID,
    receiveIDType: input.receiveIDType
  });
}

/**
 * W1 migration adapter: legacy Feishu config/client remain the credential and
 * transport authority while every inbound/outbound call crosses P09.01's
 * validated envelope boundary.
 */
export function createFeishuChannelConnector(options: FeishuConnectorOptions): ChannelConnector {
  const manifest = feishuChannelConnectorManifest();
  return {
    manifest,
    health: () => options.health?.() ?? configHealth(currentConfig(options.config)),
    ingest: (envelope) => {
      const validation = validateInboundEnvelope(envelope, manifest);
      if (!validation.ok) throw new Error(`invalid Feishu inbound connector envelope: ${validation.errors.join("; ")}`);
      return options.onInbound?.(envelope);
    },
    deliver: (envelope) => deliverFeishuEnvelope(options, manifest, envelope)
  };
}

export function feishuConnectorTarget(receiveID: string, receiveIDType: string): string {
  const id = requiredText(receiveID, "receiveID");
  const type = requiredText(receiveIDType, "receiveIDType");
  return `feishu://${encodeURIComponent(type)}/${encodeURIComponent(id)}`;
}

async function deliverFeishuEnvelope(
  options: FeishuConnectorOptions,
  manifest: ConnectorManifest,
  envelope: OutboundEnvelope
): Promise<ConnectorDeliveryReceipt> {
  assertOutboundEnvelope(envelope, manifest);
  if (!manifest.capabilities.some((item) => item.kind === "outbound" && item.id === envelope.operation)) {
    throw new Error("Feishu outbound operation is not declared by manifest");
  }
  const target = envelope.payload.schema_version === "xuanwu.im-outbound.v1"
    ? canonicalFeishuTarget(imOutboundPayloadFromEnvelope(envelope))
    : parseTarget(envelope.target);
  const config = currentConfig(options.config);
  if (!targetAllowed(config, target)) {
    throw new FeishuClientError(`Feishu ${target.receiveIDType} target is not allowed`, { kind: "permanent" });
  }
  const sender = options.sender ?? createFeishuMessageClient({ config });
  const providerRequestRef = await sendEnvelope(sender, envelope, target);
  return { provider_request_ref: providerRequestRef, replayed: false, target: envelope.target };
}

function canonicalFeishuTarget(payload: ReturnType<typeof imOutboundPayloadFromEnvelope>): {
  receiveID: string;
  receiveIDType: string;
} {
  const receiveID = requiredText(payload.target.conversation_id, "target conversation_id");
  const addressType = cleanString(payload.target.address_type);
  return {
    receiveID,
    receiveIDType: addressType === "" || addressType === "conversation_id" ? feishuReceiveIDType(receiveID) : addressType
  };
}

/** Provider-private legacy id typing; core treats the id as opaque. */
function feishuReceiveIDType(receiveID: string): string {
  if (receiveID.startsWith("ou_")) return "open_id";
  if (receiveID.startsWith("on_")) return "union_id";
  return "chat_id";
}

async function sendEnvelope(
  sender: FeishuMessageClient,
  envelope: OutboundEnvelope,
  target: { receiveID: string; receiveIDType: string }
): Promise<string> {
  if (envelope.payload.schema_version === "xuanwu.im-outbound.v1") {
    const payload = imOutboundPayloadFromEnvelope(envelope);
    if (payload.operation === "message.reply") {
      return (await sender.sendTextMessage({
        receiveId: target.receiveID,
        receiveIdType: target.receiveIDType,
        text: requiredPayloadText(payload.text, "payload.text")
      })).messageId;
    }
    if (payload.operation === "interaction.send") {
      if (!sender.sendInteractiveCard) throw new FeishuClientError("Feishu sender does not support interactive cards", { kind: "permanent" });
      return (await sender.sendInteractiveCard({
        card: renderFeishuInteraction(payload.interaction!),
        receiveId: target.receiveID,
        receiveIdType: target.receiveIDType
      })).messageId;
    }
    if (!sender.addMessageReaction) throw new FeishuClientError("Feishu sender does not support reactions", { kind: "permanent" });
    return (await sender.addMessageReaction({
      emojiType: requiredPayloadText(payload.reaction, "payload.reaction"),
      messageId: requiredPayloadText(payload.target.reply_to_message_id, "payload.target.reply_to_message_id")
    })).reactionId;
  }
  if (envelope.operation === "message.reply") {
    return (await sender.sendTextMessage({
      receiveId: target.receiveID,
      receiveIdType: target.receiveIDType,
      text: requiredPayloadText(envelope.payload.text, "payload.text")
    })).messageId;
  }
  if (envelope.operation === "card.send") {
    if (!sender.sendInteractiveCard) throw new FeishuClientError("Feishu sender does not support interactive cards", { kind: "permanent" });
    return (await sender.sendInteractiveCard({
      card: requiredPayloadRecord(envelope.payload.card, "payload.card"),
      receiveId: target.receiveID,
      receiveIdType: target.receiveIDType
    })).messageId;
  }
  if (!sender.addMessageReaction) throw new FeishuClientError("Feishu sender does not support reactions", { kind: "permanent" });
  return (await sender.addMessageReaction({
    emojiType: requiredPayloadText(envelope.payload.emoji_type, "payload.emoji_type"),
    messageId: requiredPayloadText(envelope.payload.message_id, "payload.message_id")
  })).reactionId;
}

function renderFeishuInteraction(interaction: NonNullable<ReturnType<typeof imOutboundPayloadFromEnvelope>["interaction"]>): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    elements: [
      { tag: "markdown", content: interaction.body },
      {
        tag: "action",
        actions: interaction.actions.map((action) => ({
          tag: "button",
          text: { tag: "plain_text", content: action.label },
          type: action.style,
          value: {
            action: "xuanwu_im_interaction",
            action_id: action.action_id,
            interaction_id: interaction.interaction_id,
            revision: interaction.revision
          }
        }))
      }
    ],
    header: { template: "orange", title: { tag: "plain_text", content: interaction.title } }
  };
}

function feishuConversationKind(value: string): ImInboundMessageV1["conversation"]["kind"] {
  if (["p2p", "private", "direct"].includes(cleanString(value))) return "direct";
  if (["group", "chat"].includes(cleanString(value))) return "group";
  return "unknown";
}

function feishuSenderKind(value: string): ImInboundMessageV1["sender"]["kind"] {
  if (value === "user") return "user";
  if (["bot", "app"].includes(value)) return "bot";
  return "unknown";
}

function imAttachmentKind(value: string): ImInboundMessageV1["attachments"][number]["kind"] {
  return ["image", "file", "audio", "video"].includes(value)
    ? value as ImInboundMessageV1["attachments"][number]["kind"]
    : "other";
}

function configHealth(config: FeishuConnectorConfig): ConnectorHealth {
  const enabled = feishuConnectorStatus(config).enabled === true;
  return {
    checked_at: new Date().toISOString(),
    last_error: "",
    reconnect_attempts: 0,
    state: enabled ? "degraded" : "disabled"
  };
}

function currentConfig(value: FeishuConnectorOptions["config"]): FeishuConnectorConfig {
  return typeof value === "function" ? value() : value;
}

function inboundScope(event: FeishuNormalizedMessageEvent): string {
  if (cleanString(event.thread_id) !== "") return `thread:${event.thread_id}`;
  if (cleanString(event.root_id) !== "") return `thread:${event.root_id}`;
  return `chat:${event.chat_id}`;
}

function parseTarget(value: string): { receiveID: string; receiveIDType: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid Feishu connector target");
  }
  if (url.protocol !== "feishu:") throw new Error("invalid Feishu connector target protocol");
  const receiveIDType = decodeURIComponent(url.hostname);
  const receiveID = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  return {
    receiveID: requiredText(receiveID, "target receiveID"),
    receiveIDType: requiredText(receiveIDType, "target receiveIDType")
  };
}

function targetAllowed(
  config: FeishuConnectorConfig,
  target: { receiveID: string; receiveIDType: string }
): boolean {
  if (target.receiveIDType === "chat_id") return allowed(config.allowedChatIds, target.receiveID);
  if (["email", "open_id", "union_id", "user_id"].includes(target.receiveIDType)) {
    return allowed(config.allowedUserIds, target.receiveID);
  }
  return false;
}

function allowed(values: string[], value: string): boolean {
  return values.length === 0 || values.includes(value);
}

function requiredPayloadRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is required`);
  return value as Record<string, unknown>;
}

function requiredPayloadText(value: unknown, label: string): string {
  return requiredText(value, label);
}

function requiredText(value: unknown, label: string): string {
  const text = cleanString(value);
  if (text === "") throw new Error(`${label} is required`);
  return text;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} is required`);
  return value;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
