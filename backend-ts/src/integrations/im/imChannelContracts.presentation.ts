import { type OutboundEnvelope } from "../channelConnectorContracts.ts";
import { cleanString } from "../../util/values.ts";
import { IM_DELIVERY_RECEIPT_SCHEMA_VERSION } from "./imChannelContracts.model.ts";
import type { ImOutboundPayloadV1, ImDeliveryReceiptV1, ImTargetV1 } from "./imChannelContracts.model.ts";
import { assertImOutboundPayload, requiredUriPart } from "./imChannelContracts.validation.ts";

/** Extract + validate the canonical payload carried by an OutboundEnvelope. */
export function imOutboundPayloadFromEnvelope(envelope: { operation: string; payload: Record<string, unknown> }): ImOutboundPayloadV1 {
  const payload = envelope.payload as unknown;
  assertImOutboundPayload(payload);
  const canonical = payload as ImOutboundPayloadV1;
  if (canonical.operation !== envelope.operation) {
    throw new Error("im outbound payload operation does not match envelope operation");
  }
  return canonical;
}

export function imDeliveryReceipt(input: {
  connector_id: string;
  provider_message_refs?: string[];
  provider_request_ref: string;
  target: string;
}): ImDeliveryReceiptV1 {
  return {
    connector_id: input.connector_id,
    provider_message_refs: [...(input.provider_message_refs ?? [input.provider_request_ref])],
    provider_request_ref: input.provider_request_ref,
    replayed: false,
    schema_version: IM_DELIVERY_RECEIPT_SCHEMA_VERSION,
    target: input.target
  };
}

/** Bounded, redaction-friendly serialization of a receipt for sync_outbox.result_json. */
export function imDeliveryReceiptResultJson(receipt: ImDeliveryReceiptV1): string {
  return JSON.stringify({
    connector_id: receipt.connector_id,
    provider_message_refs: receipt.provider_message_refs.slice(0, 16).map((ref) => ref.slice(0, 512)),
    provider_request_ref: receipt.provider_request_ref.slice(0, 512),
    schema_version: receipt.schema_version,
    target: receipt.target.slice(0, 4096)
  });
}

/** Canonical target URI codec. `receive_id_type` stays provider-owned. */
export function imTargetUri(target: ImTargetV1, receiveIDType: string): string {
  const connector = requiredUriPart(target.connector_id, "target connector_id");
  const type = requiredUriPart(receiveIDType, "target receive id type");
  const conversation = requiredUriPart(target.conversation_id, "target conversation_id");
  return `${encodeURIComponent(connector)}://${encodeURIComponent(type)}/${encodeURIComponent(conversation)}`;
}

/**
 * Build a P09.01 OutboundEnvelope carrying a canonical IM outbound payload.
 * The payload schema and the envelope operation always match (fail closed).
 */
export function createImOutboundEnvelope(input: {
  actionGateRef: string;
  actionID: string;
  authority: "deterministic_policy" | "human_approval";
  correlationID: string;
  eventRef: string;
  idempotencyKey: string;
  occurredAt?: string;
  payload: ImOutboundPayloadV1;
  target: string;
}): OutboundEnvelope {
  assertImOutboundPayload(input.payload);
  return {
    audit: {
      action_id: requiredUriPart(input.actionID, "actionID"),
      correlation_id: requiredUriPart(input.correlationID, "correlationID"),
      event_ref: requiredUriPart(input.eventRef, "eventRef"),
      idempotency_key: requiredUriPart(input.idempotencyKey, "idempotencyKey"),
      occurred_at: cleanString(input.occurredAt) || new Date().toISOString()
    },
    authorization: {
      action_gate_ref: requiredUriPart(input.actionGateRef, "actionGateRef"),
      authority: input.authority,
      decision: "allow"
    },
    connector_id: input.payload.target.connector_id,
    idempotency_key: requiredUriPart(input.idempotencyKey, "idempotencyKey"),
    operation: input.payload.operation,
    payload: input.payload as unknown as Record<string, unknown>,
    target: requiredUriPart(input.target, "target")
  };
}
