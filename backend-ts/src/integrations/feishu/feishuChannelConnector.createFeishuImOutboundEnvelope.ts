import type { FeishuConnectorConfig } from "./feishuTypes.ts";
import { feishuConnectorStatus } from "./feishuConfig.ts";
import { type ConnectorHealth, type OutboundEnvelope } from "../channelConnectorContracts.ts";
import { IM_OUTBOUND_SCHEMA_VERSION, createImOutboundEnvelope, imOutboundPayloadFromEnvelope } from "../im/imChannelContracts.ts";
import { cleanString } from "../../util/values.ts";
import { requiredText, FEISHU_CONNECTOR_ID, feishuConnectorTarget, createFeishuOutboundEnvelope } from "./feishuChannelConnector.createFeishuOutboundEnvelope.ts";
import type { FeishuConnectorOptions } from "./feishuChannelConnector.model.ts";

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

export function canonicalFeishuTarget(payload: ReturnType<typeof imOutboundPayloadFromEnvelope>): {
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
export function feishuReceiveIDType(receiveID: string): string {
  if (receiveID.startsWith("ou_")) return "open_id";
  if (receiveID.startsWith("on_")) return "union_id";
  return "chat_id";
}

export function renderFeishuInteraction(interaction: NonNullable<ReturnType<typeof imOutboundPayloadFromEnvelope>["interaction"]>): Record<string, unknown> {
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

export function configHealth(config: FeishuConnectorConfig): ConnectorHealth {
  const enabled = feishuConnectorStatus(config).enabled === true;
  return {
    checked_at: new Date().toISOString(),
    last_error: "",
    reconnect_attempts: 0,
    state: enabled ? "degraded" : "disabled"
  };
}

export function currentConfig(value: FeishuConnectorOptions["config"]): FeishuConnectorConfig {
  return typeof value === "function" ? value() : value;
}

export function parseTarget(value: string): { receiveID: string; receiveIDType: string } {
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

export function targetAllowed(
  config: FeishuConnectorConfig,
  target: { receiveID: string; receiveIDType: string }
): boolean {
  if (target.receiveIDType === "chat_id") return allowed(config.allowedChatIds, target.receiveID);
  if (["email", "open_id", "union_id", "user_id"].includes(target.receiveIDType)) {
    return allowed(config.allowedUserIds, target.receiveID);
  }
  return false;
}

export function allowed(values: string[], value: string): boolean {
  return values.length === 0 || values.includes(value);
}

export function requiredPayloadRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is required`);
  return value as Record<string, unknown>;
}

export function requiredPayloadText(value: unknown, label: string): string {
  return requiredText(value, label);
}

export function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} is required`);
  return value;
}
