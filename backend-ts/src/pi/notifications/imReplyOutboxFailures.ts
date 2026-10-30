import type { RunnerDatabase } from "../../db/database.ts";
import { getImReplyDraft, type SyncOutboxRecord } from "../../db/repositories/imReplyOutbox.ts";
import { markSyncOutboxFailed, markSyncOutboxRetry } from "../../db/repositories/imReplyOutboxDispatch.ts";
import { getPiAction, getPiApprovalRequest } from "../../db/repositories/pi.ts";
import { type ChannelConnector } from "../../integrations/channelConnectorContracts.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import { cleanString } from "../../util/values.ts";
import { ImOutboxDispatchResult } from "./imReplyOutboxDispatcher.ts";

export function handleSendError(
  db: RunnerDatabase,
  outbox: SyncOutboxRecord,
  error: unknown,
  now: Date,
  result: ImOutboxDispatchResult
): void {
  const summary = safeError(error);
  const kind = deliveryErrorKind(error);
  if (kind === "auth" || kind === "permanent") {
    return fail(db, outbox, summary, now, result);
  }
  const next = markSyncOutboxRetry(db, outbox.id, {
    error: summary,
    retryAfterSeconds: deliveryRetryAfterSeconds(error),
    timestamp: now
  });
  if (next.status === "failed") result.failed += 1;
  else result.retry += 1;
}

/**
 * Provider-neutral delivery error classification. Adapters may throw any error
 * exposing `{ kind, retryAfterSeconds }`; the legacy FeishuClientError shape is
 * the same contract and stays supported during the compat window.
 */
export function deliveryErrorKind(error: unknown): string {
  const kind = (error as { kind?: unknown } | null)?.kind;
  return typeof kind === "string" ? kind : "transient";
}

export function deliveryRetryAfterSeconds(error: unknown): number | undefined {
  const value = (error as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function fail(
  db: RunnerDatabase,
  outbox: SyncOutboxRecord,
  error: string,
  now: Date,
  result: ImOutboxDispatchResult
): void {
  markSyncOutboxFailed(db, outbox.id, { error, timestamp: now });
  result.failed += 1;
}

export function preflightPolicy(db: RunnerDatabase, outbox: SyncOutboxRecord): string {
  if (outbox.source.trim() === "") return "outbox source is empty";
  if (outbox.status !== "sending") return `outbox is not claimed for sending: ${outbox.status}`;
  if (getImReplyDraft(db, outbox.reply_draft_id)?.status !== "approved") return "reply draft is not approved";
  if (outbox.provider_request_ref !== "") return "outbox already has a delivery receipt";
  if (outbox.content.trim() === "") return "outbox content is empty";
  if (outbox.risk !== "low") return `outbox risk is not allowed: ${outbox.risk}`;
  const approval = approvalRequestID(outbox);
  const piActionID = piActionIDFromApprovalActionID(approval);
  if (piActionID !== "" && !getPiAction(db, piActionID)) return "PI action is missing";
  if (approval !== "" && piActionIDFromApprovalActionID(approval) === "" && !getPiApprovalRequest(db, approval)) {
    return "approval request is missing";
  }
  if (targetConversationID(outbox) === "") return "outbox receive id is empty";
  return "";
}

export function declares(connector: ChannelConnector, capability: string): boolean {
  return connector.manifest.capabilities.some((item) => item.kind === "outbound" && item.id === capability);
}

export function approvalRequestID(outbox: SyncOutboxRecord): string {
  return outbox.approval_action_id.trim();
}

export function targetConversationID(outbox: SyncOutboxRecord): string {
  return outbox.target_chat_id || outbox.target_thread_id || outbox.target_message_id;
}

export function receiveIDType(_outbox: SyncOutboxRecord): string {
  return "conversation_id";
}

export function piActionIDFromApprovalActionID(value: string): string {
  const text = cleanString(value);
  return text.startsWith("pi_action:") ? cleanString(text.slice("pi_action:".length)) : "";
}

export function emptyResult(): ImOutboxDispatchResult {
  return { failed: 0, processed: 0, retry: 0, sent: 0, skipped: 0 };
}

export function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}
