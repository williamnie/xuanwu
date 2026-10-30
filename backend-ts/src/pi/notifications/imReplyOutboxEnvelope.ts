import type { RunnerDatabase } from "../../db/database.ts";
import { type SyncOutboxRecord } from "../../db/repositories/imReplyOutbox.ts";
import { getExternalEvent } from "../../db/repositories/externalEvents.ts";
import { ensureImInteractionBinding } from "../../db/repositories/imInteractionBindings.ts";
import { getPiAction, getPiApprovalRequest } from "../../db/repositories/pi.ts";
import { type ChannelConnector, type OutboundEnvelope } from "../../integrations/channelConnectorContracts.ts";
import { IM_OUTBOUND_SCHEMA_VERSION, createImOutboundEnvelope, imTargetUri, type ImInteractionActionV1, type ImOutboundPayloadV1 } from "../../integrations/im/imChannelContracts.ts";
import { cleanString, objectValue } from "../../util/values.ts";
import { declares, targetConversationID, receiveIDType, approvalRequestID, piActionIDFromApprovalActionID } from "./imReplyOutboxFailures.ts";

/**
 * Build only the canonical provider-neutral payload. Provider presentation
 * (Feishu cards, Telegram keyboards, text fallback) belongs to the connector.
 */
export function buildOutboundEnvelope(
  db: RunnerDatabase,
  outbox: SyncOutboxRecord,
  connector: ChannelConnector,
  now: Date
): OutboundEnvelope {
  const interaction = declares(connector, "interaction.send") ? buildInteraction(db, outbox, now) : null;
  return buildCanonicalEnvelope(outbox, connector.manifest.id, interaction);
}

export function buildCanonicalEnvelope(
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

export function buildInteraction(db: RunnerDatabase, outbox: SyncOutboxRecord, now: Date) {
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

export function interactionSpec(db: RunnerDatabase, outbox: SyncOutboxRecord): {
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

export function interactionActor(db: RunnerDatabase, externalEventID: number): { id?: string; openId?: string } {
  const event = getExternalEvent(db, externalEventID);
  const sender = objectValue(event?.normalized_message.sender);
  const id = cleanString(sender.id);
  const openId = cleanString(sender.open_id);
  return { ...(id ? { id } : {}), ...(openId ? { openId } : {}) };
}
