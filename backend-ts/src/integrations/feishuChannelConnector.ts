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
  type FeishuMessageClient
} from "./feishuClient.ts";

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
      { id: "card.send", kind: "outbound", requires_authorization: true },
      { id: "reaction.add", kind: "outbound", requires_authorization: true }
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
      attachments: event.attachments,
      chat_id: event.chat_id,
      chat_type: event.chat_type,
      mentions: event.mentions,
      message_id: event.message_id,
      project_hint: projectHint,
      root_id: event.root_id,
      sender: event.sender,
      text: event.text,
      thread_id: event.thread_id
    },
    source: FEISHU_CONNECTOR_ID
  };
  const validation = validateInboundEnvelope(envelope, feishuChannelConnectorManifest());
  if (!validation.ok) throw new Error(`invalid Feishu inbound connector envelope: ${validation.errors.join("; ")}`);
  return envelope;
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
  const target = parseTarget(envelope.target);
  const config = currentConfig(options.config);
  if (!targetAllowed(config, target)) throw new Error(`Feishu ${target.receiveIDType} target is not allowed`);
  const sender = options.sender ?? createFeishuMessageClient({ config });
  const providerRequestRef = await sendEnvelope(sender, envelope, target);
  return { provider_request_ref: providerRequestRef, replayed: false, target: envelope.target };
}

async function sendEnvelope(
  sender: FeishuMessageClient,
  envelope: OutboundEnvelope,
  target: { receiveID: string; receiveIDType: string }
): Promise<string> {
  if (envelope.operation === "message.reply") {
    return (await sender.sendTextMessage({
      receiveId: target.receiveID,
      receiveIdType: target.receiveIDType,
      text: requiredPayloadText(envelope.payload.text, "payload.text")
    })).messageId;
  }
  if (envelope.operation === "card.send") {
    if (!sender.sendInteractiveCard) throw new Error("Feishu sender does not support interactive cards");
    return (await sender.sendInteractiveCard({
      card: requiredPayloadRecord(envelope.payload.card, "payload.card"),
      receiveId: target.receiveID,
      receiveIdType: target.receiveIDType
    })).messageId;
  }
  if (!sender.addMessageReaction) throw new Error("Feishu sender does not support reactions");
  return (await sender.addMessageReaction({
    emojiType: requiredPayloadText(envelope.payload.emoji_type, "payload.emoji_type"),
    messageId: requiredPayloadText(envelope.payload.message_id, "payload.message_id")
  })).reactionId;
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
