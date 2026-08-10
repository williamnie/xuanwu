import type { RunnerDatabase } from "../db/database.ts";
import { upsertExternalEvent, type ExternalEventRecord } from "../db/repositories/externalEvents.ts";
import type { InboundEnvelope } from "./channelConnectorContracts.ts";
import { validateImInboundMessage, type ImInboundMessageV1 } from "./imChannelContracts.ts";

/**
 * Single provider-neutral inbox writer. Channel adapters normalize transport
 * events into ImInboundMessageV1; only this service performs the durable
 * external_events upsert.
 */
export function ingestImInboundEnvelope(
  db: RunnerDatabase,
  envelope: InboundEnvelope,
  options: {
    projectId?: string;
    raw?: unknown;
    status?: string;
    summary?: Record<string, unknown>;
  } = {}
): ExternalEventRecord {
  const validation = validateImInboundMessage(envelope.payload);
  if (!validation.ok) throw new Error(`invalid im inbound message: ${validation.errors.join("; ")}`);
  const message = envelope.payload as unknown as ImInboundMessageV1;
  if (message.connector_id !== envelope.connector_id || message.connector_id !== envelope.source) {
    throw new Error("im inbound connector identity mismatch");
  }
  const projectId = cleanString(options.projectId);
  return upsertExternalEvent(db, {
    actor: `${message.connector_id}:${message.sender.kind}:${message.sender.id}`,
    attachments: message.attachments.map((item) => ({
      kind: item.kind === "other" ? "file" : item.kind,
      mime_type: item.mime_type,
      name: item.name,
      remote_ref: item.id,
      size: item.size_bytes
    })),
    content: message.text || attachmentSummary(message),
    dedupe_key: envelope.audit.idempotency_key,
    event_type: envelope.event_type,
    external_id: message.message_id,
    normalized_message: normalizedProjection(message),
    occurred_at: message.occurred_at,
    project_hint: projectId,
    project_id: projectId,
    provider: message.connector_id,
    raw_json: options.raw,
    raw_payload_ref: message.raw_event_ref,
    received_at: message.occurred_at,
    source: message.connector_id,
    status: cleanString(options.status) || (projectId === "" ? "unassigned" : "mapped"),
    summary: options.summary ?? canonicalSummary(message, projectId),
    trust_level: "untrusted"
  });
}

/** W1 read compatibility while consumers migrate to the nested canonical form. */
function normalizedProjection(message: ImInboundMessageV1): Record<string, unknown> {
  return {
    ...(message as unknown as Record<string, unknown>),
    chat_id: message.conversation.id,
    chat_type: message.conversation.kind,
    root_id: message.thread?.root_message_id ?? "",
    thread_id: message.thread?.id ?? ""
  };
}

function canonicalSummary(message: ImInboundMessageV1, projectId: string): Record<string, unknown> {
  return {
    attachment_count: message.attachments.length,
    conversation_id: message.conversation.id,
    message_id: message.message_id,
    project_id: projectId,
    sender_kind: message.sender.kind,
    text_length: message.text.length
  };
}

function attachmentSummary(message: ImInboundMessageV1): string {
  return message.attachments.length === 0
    ? `[empty ${message.connector_id} message]`
    : `[${message.attachments.length} ${message.connector_id} attachment metadata item(s)]`;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
