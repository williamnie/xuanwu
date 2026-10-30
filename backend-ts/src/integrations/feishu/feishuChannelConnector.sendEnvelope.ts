import { assertOutboundEnvelope, validateInboundEnvelope, type ChannelConnector, type ConnectorDeliveryReceipt, type ConnectorManifest, type OutboundEnvelope } from "../channelConnectorContracts.ts";
import { createFeishuMessageClient, FeishuClientError, type FeishuMessageClient } from "./feishuClient.ts";
import { imOutboundPayloadFromEnvelope } from "../im/imChannelContracts.ts";
import type { FeishuConnectorOptions } from "./feishuChannelConnector.model.ts";
import { feishuChannelConnectorManifest } from "./feishuChannelConnector.createFeishuOutboundEnvelope.ts";
import { configHealth, currentConfig, canonicalFeishuTarget, parseTarget, targetAllowed, requiredPayloadText, renderFeishuInteraction, requiredPayloadRecord } from "./feishuChannelConnector.createFeishuImOutboundEnvelope.ts";

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

export async function deliverFeishuEnvelope(
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

export async function sendEnvelope(
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
