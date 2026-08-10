import type { RunnerDatabase } from "../db/database.ts";
import { getImReplyDraft, type SyncOutboxRecord } from "../db/repositories/imReplyOutbox.ts";
import { getExternalEvent } from "../db/repositories/externalEvents.ts";
import { ensureImInteractionBinding } from "../db/repositories/imInteractionBindings.ts";
import {
  claimSyncOutboxSending,
  listDispatchableSyncOutbox,
  markSyncOutboxFailed,
  markSyncOutboxRetry,
  markSyncOutboxSent
} from "../db/repositories/imReplyOutboxDispatch.ts";
import { getPiAction, getPiApprovalRequest } from "../db/repositories/pi.ts";
import { assertOutboundEnvelope, type ChannelConnector, type OutboundEnvelope } from "../integrations/channelConnectorContracts.ts";
import {
  IM_OUTBOUND_SCHEMA_VERSION,
  createImOutboundEnvelope,
  imDeliveryReceipt,
  imDeliveryReceiptResultJson,
  imOutboundPayloadFromEnvelope,
  imTargetUri,
  type ImInteractionActionV1,
  type ImOutboundPayloadV1
} from "../integrations/imChannelContracts.ts";
import { redactSensitiveText } from "../util/redact.ts";

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

async function dispatchOne(
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

function storedCanonicalEnvelope(
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

/**
 * Build only the canonical provider-neutral payload. Provider presentation
 * (Feishu cards, Telegram keyboards, text fallback) belongs to the connector.
 */
function buildOutboundEnvelope(
  db: RunnerDatabase,
  outbox: SyncOutboxRecord,
  connector: ChannelConnector,
  now: Date
): OutboundEnvelope {
  const interaction = declares(connector, "interaction.send") ? buildInteraction(db, outbox, now) : null;
  return buildCanonicalEnvelope(outbox, connector.manifest.id, interaction);
}

function buildCanonicalEnvelope(
  outbox: SyncOutboxRecord,
  connectorID: string,
  interaction: ReturnType<typeof buildInteraction>
): OutboundEnvelope {
  const outboxRef = `sync_outbox:${outbox.id}`;
  const conversationID = targetConversationID(outbox);
  if (conversationID === "") throw new Error("outbox target is empty");
  const target = {
    connector_id: connectorID,
    conversation_id: conversationID,
    ...(outbox.target_thread_id ? { thread_id: outbox.target_thread_id } : {}),
    ...(outbox.target_message_id ? { reply_to_message_id: outbox.target_message_id } : {})
  };
  const payload: ImOutboundPayloadV1 = interaction
    ? {
        fallback_text: outbox.content,
        interaction,
        operation: "interaction.send",
        refs: { action_ref: outbox.approval_action_id },
        schema_version: IM_OUTBOUND_SCHEMA_VERSION,
        target
      }
    : {
        operation: "message.reply",
        schema_version: IM_OUTBOUND_SCHEMA_VERSION,
        target,
        text: outbox.content
      };
  return createImOutboundEnvelope({
    actionGateRef: `im_reply_drafts:${outbox.reply_draft_id}:approved`,
    actionID: cleanString(outbox.approval_action_id) || outboxRef,
    authority: "deterministic_policy",
    correlationID: outbox.external_event_id > 0
      ? `external_events:${outbox.external_event_id}`
      : outbox.issue_id > 0 ? `issues:${outbox.issue_id}` : outboxRef,
    eventRef: outboxRef,
    idempotencyKey: outboxRef,
    occurredAt: outbox.created_at,
    payload,
    target: imTargetUri(target, receiveIDType(outbox))
  });
}

function buildInteraction(db: RunnerDatabase, outbox: SyncOutboxRecord, now: Date) {
  const spec = interactionSpec(db, outbox);
  const actor = interactionActor(db, outbox.external_event_id);
  if (!spec || (!actor.id && !actor.openId)) return null;
  const scopeKey = targetConversationID(outbox);
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const binding = ensureImInteractionBinding(db, {
    actionKind: spec.kind,
    actionRef: spec.ref,
    actions: spec.actions.map((action) => ({ action_id: action.action_id, value: spec.values[action.action_id]! })),
    actor,
    connectorId: outbox.source,
    conversationId: scopeKey,
    expiresAt,
    revision: 1,
    scopeKey,
    sourceMessageId: outbox.target_message_id
  }, now);
  return {
    actions: spec.actions,
    body: outbox.content,
    expires_at: binding.expires_at,
    interaction_id: binding.interaction_id,
    kind: "approval" as const,
    revision: binding.revision,
    schema_version: "xuanwu.im-interaction.v1" as const,
    title: spec.title
  };
}

function interactionSpec(db: RunnerDatabase, outbox: SyncOutboxRecord): {
  actions: ImInteractionActionV1[];
  kind: "approval" | "pi_action";
  ref: string;
  title: string;
  values: Record<string, string>;
} | null {
  const approvalID = approvalRequestID(outbox);
  const piActionID = piActionIDFromApprovalActionID(approvalID);
  if (piActionID !== "") {
    const action = getPiAction(db, piActionID);
    if (!action) return null;
    const actions: ImInteractionActionV1[] = [
      { action_id: "approve", label: "批准执行", style: "primary" },
      ...(action.action_type === "mcp.tool.call" ? [{ action_id: "approve_always", label: "当前项目始终允许", style: "default" as const }] : []),
      { action_id: "reject", label: "拒绝", style: "danger" },
      { action_id: "request_changes", label: "要求修改", style: "default" },
      { action_id: "snooze", label: "暂缓 30 分钟", style: "default" }
    ];
    return {
      actions,
      kind: "pi_action",
      ref: `pi_actions:${piActionID}`,
      title: outbox.issue_id > 0 ? `Issue #${outbox.issue_id} 等待 Supervisor 动作确认` : "Supervisor 动作等待确认",
      values: { approve: "approve", approve_always: "approve_always", reject: "reject", request_changes: "request_changes", snooze: "snooze:30" }
    };
  }
  const approval = approvalID ? getPiApprovalRequest(db, approvalID) : null;
  if (!approval) return null;
  return {
    actions: [
      { action_id: "approve_once", label: "批准一次", style: "primary" },
      { action_id: "approve_session", label: "本 session 批准", style: "primary" },
      { action_id: "deny", label: "拒绝", style: "danger" },
      { action_id: "defer", label: "暂缓", style: "default" }
    ],
    kind: "approval",
    ref: `pi_approval_requests:${approval.approval_id}`,
    title: approval.issue_id > 0 || outbox.issue_id > 0 ? `Issue #${approval.issue_id || outbox.issue_id} 等待授权` : "Code Agent 等待授权",
    values: { approve_once: "approve:turn", approve_session: "approve_session:session", defer: "defer:turn", deny: "deny:turn" }
  };
}

function interactionActor(db: RunnerDatabase, externalEventID: number): { id?: string; openId?: string } {
  const event = getExternalEvent(db, externalEventID);
  const sender = recordValue(event?.normalized_message.sender);
  const id = cleanString(sender.id);
  const openId = cleanString(sender.open_id);
  return { ...(id ? { id } : {}), ...(openId ? { openId } : {}) };
}

function handleSendError(
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
function deliveryErrorKind(error: unknown): string {
  const kind = (error as { kind?: unknown } | null)?.kind;
  return typeof kind === "string" ? kind : "transient";
}

function deliveryRetryAfterSeconds(error: unknown): number | undefined {
  const value = (error as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function fail(
  db: RunnerDatabase,
  outbox: SyncOutboxRecord,
  error: string,
  now: Date,
  result: ImOutboxDispatchResult
): void {
  markSyncOutboxFailed(db, outbox.id, { error, timestamp: now });
  result.failed += 1;
}

function preflightPolicy(db: RunnerDatabase, outbox: SyncOutboxRecord): string {
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

function declares(connector: ChannelConnector, capability: string): boolean {
  return connector.manifest.capabilities.some((item) => item.kind === "outbound" && item.id === capability);
}

function approvalRequestID(outbox: SyncOutboxRecord): string {
  return outbox.approval_action_id.trim();
}

function targetConversationID(outbox: SyncOutboxRecord): string {
  return outbox.target_chat_id || outbox.target_thread_id || outbox.target_message_id;
}

function receiveIDType(_outbox: SyncOutboxRecord): string {
  return "conversation_id";
}

function piActionIDFromApprovalActionID(value: string): string {
  const text = cleanString(value);
  return text.startsWith("pi_action:") ? cleanString(text.slice("pi_action:".length)) : "";
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function emptyResult(): ImOutboxDispatchResult {
  return { failed: 0, processed: 0, retry: 0, sent: 0, skipped: 0 };
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}
