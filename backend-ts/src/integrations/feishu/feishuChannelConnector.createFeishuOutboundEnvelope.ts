import type { FeishuNormalizedMessageEvent } from "./feishuTypes.ts";
import { normalizeFeishuMessageEvent } from "./feishuEvents.ts";
import { CHANNEL_CONNECTOR_CONTRACT_VERSION, validateInboundEnvelope, type ConnectorManifest, type InboundEnvelope, type OutboundEnvelope } from "../channelConnectorContracts.ts";
import { IM_MESSAGE_SCHEMA_VERSION, type ImInboundMessageV1 } from "../im/imChannelContracts.ts";
import { cleanString } from "../../util/values.ts";
import type { FeishuConnectorInbound } from "./feishuChannelConnector.model.ts";

export const FEISHU_CONNECTOR_ID = "feishu" as const;

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

export function feishuConnectorTarget(receiveID: string, receiveIDType: string): string {
  const id = requiredText(receiveID, "receiveID");
  const type = requiredText(receiveIDType, "receiveIDType");
  return `feishu://${encodeURIComponent(type)}/${encodeURIComponent(id)}`;
}

export function feishuConversationKind(value: string): ImInboundMessageV1["conversation"]["kind"] {
  if (["p2p", "private", "direct"].includes(cleanString(value))) return "direct";
  if (["group", "chat"].includes(cleanString(value))) return "group";
  return "unknown";
}

export function feishuSenderKind(value: string): ImInboundMessageV1["sender"]["kind"] {
  if (value === "user") return "user";
  if (["bot", "app"].includes(value)) return "bot";
  return "unknown";
}

export function imAttachmentKind(value: string): ImInboundMessageV1["attachments"][number]["kind"] {
  return ["image", "file", "audio", "video"].includes(value)
    ? value as ImInboundMessageV1["attachments"][number]["kind"]
    : "other";
}

export function inboundScope(event: FeishuNormalizedMessageEvent): string {
  if (cleanString(event.thread_id) !== "") return `thread:${event.thread_id}`;
  if (cleanString(event.root_id) !== "") return `thread:${event.root_id}`;
  return `chat:${event.chat_id}`;
}

export function requiredText(value: unknown, label: string): string {
  const text = cleanString(value);
  if (text === "") throw new Error(`${label} is required`);
  return text;
}
