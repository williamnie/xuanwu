import type { RunnerDatabase } from "../db/database.ts";
import {
  approveImReplyDraft,
  createImReplyDraft,
  getSyncOutbox,
  getSyncOutboxByDedupe,
  setSyncOutboxCanonicalEnvelope,
  type SyncOutboxRecord
} from "../db/repositories/imReplyOutbox.ts";
import { markSyncOutboxFailed } from "../db/repositories/imReplyOutboxDispatch.ts";
import { dispatchImOutbox } from "../pi/imReplyOutboxDispatcher.ts";
import {
  assertOutboundEnvelope,
  type ChannelConnector,
  type ConnectorDeliveryReceipt,
  type OutboundEnvelope
} from "./channelConnectorContracts.ts";
import { imOutboundPayloadFromEnvelope } from "./imChannelContracts.ts";

/**
 * Durable immediate-send gateway for conversational replies/reactions.
 * It preserves the single draft -> sync_outbox -> generic dispatcher ->
 * connector chain while allowing a request handler to await the receipt.
 */
export async function deliverImOutboundNow(input: {
  connector: ChannelConnector;
  content: string;
  database: RunnerDatabase;
  envelope: OutboundEnvelope;
  externalEventId?: number;
  issueId?: number;
  /** Use when a higher-level audited policy owns retry cadence and attempts. */
  retryAuthority?: "caller" | "outbox";
  targetChatId?: string;
  targetMessageId?: string;
  targetThreadId?: string;
  timestamp?: Date;
}): Promise<ConnectorDeliveryReceipt> {
  assertOutboundEnvelope(input.envelope, input.connector.manifest);
  imOutboundPayloadFromEnvelope(input.envelope);
  const outbox = ensureCanonicalOutbox(input);
  if (outbox.status === "sent" && outbox.provider_request_ref !== "") {
    return { provider_request_ref: outbox.provider_request_ref, replayed: true, target: input.envelope.target };
  }
  await dispatchImOutbox({
    database: input.database,
    now: input.timestamp,
    outboxId: outbox.id,
    resolveConnector: (source) => {
      if (source !== input.connector.manifest.id) throw new Error(`unexpected IM connector: ${source}`);
      return input.connector;
    }
  });
  const delivered = getSyncOutbox(input.database, outbox.id);
  if (!delivered || delivered.status !== "sent" || delivered.provider_request_ref === "") {
    if (delivered?.status === "retry" && input.retryAuthority === "caller") {
      markSyncOutboxFailed(input.database, delivered.id, {
        error: delivered.last_error || "IM delivery retry delegated to caller",
        timestamp: input.timestamp
      });
    }
    throw new Error(delivered?.last_error || `IM delivery did not reach sent state: ${delivered?.status ?? "missing"}`);
  }
  return { provider_request_ref: delivered.provider_request_ref, replayed: false, target: input.envelope.target };
}

function ensureCanonicalOutbox(input: Parameters<typeof deliverImOutboundNow>[0]): SyncOutboxRecord {
  const source = input.connector.manifest.id;
  const dedupeKey = input.envelope.idempotency_key;
  const existing = getSyncOutboxByDedupe(input.database, source, dedupeKey);
  if (existing) return existing;
  const timestamp = input.timestamp ?? new Date();
  return input.database.transaction(() => {
    const replay = getSyncOutboxByDedupe(input.database, source, dedupeKey);
    if (replay) return replay;
    const draft = createImReplyDraft(input.database, {
      content: input.content,
      created_by: "im-channel-runtime",
      external_event_id: input.externalEventId,
      issue_id: input.issueId,
      risk: "low",
      source,
      status: "pending",
      target_chat_id: input.targetChatId,
      target_message_id: input.targetMessageId,
      target_thread_id: input.targetThreadId
    }, timestamp);
    const approved = approveImReplyDraft(input.database, draft.id, timestamp);
    return setSyncOutboxCanonicalEnvelope(input.database, approved.outbox.id, {
      correlationId: input.envelope.audit.correlation_id,
      dedupeKey,
      payloadJson: JSON.stringify(input.envelope),
      timestamp
    });
  }).immediate();
}
