import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../db/database.ts";
import { getPiNotificationIntent, markPiApprovalDelivered, updatePiNotificationIntent, type PiNotificationIntent } from "../db/repositories/pi.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { cleanString, objectValue, positiveInteger } from "../util/values.ts";
import { DEFAULT_LIMIT } from "./agentCommunicationGateway.model.ts";
import type { CommunicationEnvelope, AgentCommunicationGatewayResult } from "./agentCommunicationGateway.model.ts";

export function communicationGroups(intents: PiNotificationIntent[]): PiNotificationIntent[][] {
  const groups = new Map<string, PiNotificationIntent[]>();
  for (const intent of intents) {
    const envelope = communicationEnvelope(intent);
    const actionBoundary = envelope.approvalActionID === "" ? "batch" : envelope.approvalActionID;
    const key = [intent.project_id, envelope.channel, deliveryTargetIdentity(envelope), actionBoundary].join("\0");
    const group = groups.get(key) ?? [];
    group.push(intent);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function communicationEnvelope(intent: PiNotificationIntent): CommunicationEnvelope {
  const value = objectValue(safePayload(intent.payload_json).agent_communication);
  const route = objectValue(value.route);
  return {
    approvalActionID: cleanString(value.approval_action_id),
    channel: cleanString(route.channel) || intent.target_channel,
    contentSeed: cleanString(value.content_seed),
    notificationID: cleanString(value.notification_id),
    notificationType: cleanString(value.notification_type),
    target: {
      chatID: cleanString(route.chatID) || cleanString(route.chat_id) || intent.target_chat_id,
      eventID: positiveInteger(route.eventID) || positiveInteger(route.event_id),
      messageID: cleanString(route.messageID) || cleanString(route.message_id) || intent.target_message_id,
      threadID: cleanString(route.threadID) || cleanString(route.thread_id) || intent.target_thread_id
    }
  };
}

export function markSent(db: RunnerDatabase, intent: PiNotificationIntent, outboxID: number, now: Date): void {
  updatePiNotificationIntent(db, intent.id, {
    error: "",
    sent_at: now.toISOString(),
    sent_outbox_id: outboxID,
    state: "sent"
  });
}

export function markSuppressed(db: RunnerDatabase, intent: PiNotificationIntent, reason: string): void {
  updatePiNotificationIntent(db, intent.id, {
    decision: "suppress",
    error: redactSensitiveText(reason),
    state: "suppressed"
  });
}

export function markApprovalDelivered(db: RunnerDatabase, intents: PiNotificationIntent[]): void {
  for (const intent of intents) {
    const envelope = communicationEnvelope(intent);
    if (envelope.notificationType !== "feishu_approval_notification" || envelope.approvalActionID === "") continue;
    markPiApprovalDelivered(db, envelope.approvalActionID, { channel: envelope.channel });
  }
}

export function markCoveredIntents(
  db: RunnerDatabase,
  parents: PiNotificationIntent[],
  outboxID: number,
  now: Date,
  reason: string
): void {
  for (const id of coveredIntentIDs(parents)) {
    const intent = getPiNotificationIntent(db, id);
    if (!intent || intent.sent_outbox_id > 0 || intent.state === "sent") continue;
    if (outboxID > 0) markSent(db, intent, outboxID, now);
    else markSuppressed(db, intent, reason);
  }
}

export function coveredIntentIDs(intents: PiNotificationIntent[]): string[] {
  const ids = intents.flatMap((intent) => {
    const value = safePayload(intent.payload_json).intent_ids;
    return Array.isArray(value) ? value.map(cleanString).filter(Boolean) : [];
  });
  return [...new Set(ids)];
}

export function hasTarget(envelope: CommunicationEnvelope): boolean {
  return [envelope.target.chatID, envelope.target.threadID, envelope.target.messageID]
    .some((value) => cleanString(value) !== "");
}

export function singleIssueID(intents: PiNotificationIntent[]): number {
  const ids = [...new Set(intents.map((intent) => intent.issue_id).filter((id) => id > 0))];
  return ids.length === 1 ? ids[0]! : 0;
}

export function groupDigest(intents: PiNotificationIntent[]): string {
  const ids = intents.map((intent) => intent.id).sort().join("\0");
  return createHash("sha256").update(ids).digest("hex").slice(0, 20);
}

export function fallbackIdentity(intent: PiNotificationIntent): string {
  const envelope = communicationEnvelope(intent);
  return createHash("sha256").update([
    intent.project_id,
    envelope.channel,
    deliveryTargetIdentity(envelope)
  ].join("\0")).digest("hex").slice(0, 16);
}

export function deliveryTargetIdentity(envelope: CommunicationEnvelope): string {
  return envelope.target.chatID || envelope.target.threadID || envelope.target.messageID;
}

export function safePayload(value: string): Record<string, unknown> {
  try {
    return objectValue(JSON.parse(value || "{}"));
  } catch {
    return {};
  }
}

export function boundedLimit(value: number | undefined): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? Math.min(value!, DEFAULT_LIMIT) : DEFAULT_LIMIT;
}

export function emptyResult(intents: number, groups: number): AgentCommunicationGatewayResult {
  return { fallback: 0, failed: 0, groups, intents, queued: 0, suppressed: 0 };
}

export function safeError(error: unknown): string {
  const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
  return message.split("\n", 1)[0]!.slice(0, 240);
}
