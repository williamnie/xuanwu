import type { RunnerDatabase } from "../../db/database.ts";
import { type SyncOutboxRecord } from "../../db/repositories/imReplyOutbox.ts";
import { claimSyncOutboxSending, listDispatchableSyncOutbox, markSyncOutboxSent } from "../../db/repositories/imReplyOutboxDispatch.ts";
import { assertOutboundEnvelope, type ChannelConnector, type OutboundEnvelope } from "../../integrations/channelConnectorContracts.ts";
import { imDeliveryReceipt, imDeliveryReceiptResultJson, imOutboundPayloadFromEnvelope } from "../../integrations/im/imChannelContracts.ts";
import { cleanString } from "../../util/values.ts";
import { buildOutboundEnvelope } from "./imReplyOutboxEnvelope.ts";
import { emptyResult, fail, safeError, preflightPolicy, handleSendError } from "./imReplyOutboxFailures.ts";

export type ImOutboxDispatchResult = {
  failed: number;
  processed: number;
  retry: number;
  sent: number;
  skipped: number;
};

export type ImOutboxDispatchOptions = {
  database: RunnerDatabase;
  limit?: number;
  now?: Date;
  outboxId?: number;
  /** Resolve the registry-owned connector for an outbox `source`/connector id. */
  resolveConnector: (source: string) => ChannelConnector;
  /** Restrict dispatch to one connector/source; defaults to all im_reply rows. */
  source?: string;
};

/**
 * Generic IM outbox dispatcher (design A4): the single production delivery
 * authority for `operation_kind='im_reply'` rows. It claims once, resolves the
 * connector from the registry by `source`, builds exactly one OutboundEnvelope
 * and calls `ChannelConnector.deliver` exactly once. Provider presentation
 * (Feishu card building) stays inside the per-connector envelope builder; the
 * dispatcher itself never imports provider SDK clients.
 *
 * Callers must wire exactly one dispatcher loop per process (scheduler phases
 * and the manual HTTP trigger share this function; the sync_outbox claim CAS
 * keeps competing workers from double-sending).
 */
export async function dispatchImOutbox(options: ImOutboxDispatchOptions): Promise<ImOutboxDispatchResult> {
  const now = options.now ?? new Date();
  const result = emptyResult();
  const candidates = listDispatchableSyncOutbox(options.database, {
    limit: options.limit,
    now,
    id: options.outboxId,
    source: options.source
  });
  for (const candidate of candidates) {
    const claimed = claimSyncOutboxSending(options.database, candidate.id, now);
    if (!claimed) {
      result.skipped += 1;
      continue;
    }
    await dispatchOne(options, claimed, now, result);
  }
  return result;
}

export async function dispatchOne(
  options: ImOutboxDispatchOptions,
  outbox: SyncOutboxRecord,
  now: Date,
  result: ImOutboxDispatchResult
): Promise<void> {
  result.processed += 1;
  let connector: ChannelConnector;
  try {
    connector = options.resolveConnector(outbox.source);
  } catch (error) {
    // Unregistered/disabled channel is a diagnosable permanent config error,
    // never a silent fallback to another provider.
    return fail(options.database, outbox, safeError(error), now, result);
  }
  if (!connector || typeof connector.deliver !== "function") {
    return fail(options.database, outbox, `im channel connector cannot deliver: ${outbox.source}`, now, result);
  }
  const policy = preflightPolicy(options.database, outbox);
  if (policy) return fail(options.database, outbox, policy, now, result);
  try {
    const envelope = storedCanonicalEnvelope(outbox, connector) ?? buildOutboundEnvelope(
      options.database,
      outbox,
      connector,
      now
    );
    const receipt = await connector.deliver(envelope);
    const canonical = imDeliveryReceipt({
      connector_id: outbox.source,
      provider_message_refs: receipt.provider_message_refs,
      provider_request_ref: receipt.provider_request_ref,
      target: receipt.target
    });
    markSyncOutboxSent(options.database, outbox.id, {
      providerRequestRef: canonical.provider_request_ref,
      resultJson: imDeliveryReceiptResultJson(canonical),
      timestamp: now
    });
    result.sent += 1;
  } catch (error) {
    handleSendError(options.database, outbox, error, now, result);
  }
}

export function storedCanonicalEnvelope(
  outbox: SyncOutboxRecord,
  connector: ChannelConnector
): OutboundEnvelope | null {
  const raw = cleanString(outbox.payload_json);
  if (raw === "" || raw === "{}") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("sync outbox canonical IM envelope is invalid JSON");
  }
  assertOutboundEnvelope(parsed, connector.manifest);
  const envelope = parsed as OutboundEnvelope;
  imOutboundPayloadFromEnvelope(envelope);
  if (envelope.connector_id !== outbox.source) throw new Error("sync outbox connector does not match canonical envelope");
  if (outbox.dedupe_key !== "" && envelope.idempotency_key !== outbox.dedupe_key) {
    throw new Error("sync outbox dedupe key does not match canonical envelope");
  }
  return envelope;
}
