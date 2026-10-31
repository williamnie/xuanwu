import type { RunnerDatabase } from "../db/database.ts";
import { createExternalLink } from "../db/repositories/externalLinks.ts";
import { getPiAction, getPiApprovalRequest, listPiNotificationIntents, type PiNotificationIntent } from "../db/repositories/pi.ts";
import { resolveAgentCommunicationIncident } from "./agentCommunicationIncidents.ts";
import { applyNotificationSpeaker, notificationPresentation } from "./notificationPresentation.ts";
import type { AgentCommunicationDecider, AgentCommunicationGatewayResult } from "./agentCommunicationGateway.model.ts";
import { boundedLimit, communicationGroups, emptyResult, markSuppressed, fallbackIdentity, markCoveredIntents, markSent, markApprovalDelivered, communicationEnvelope } from "./agentCommunicationGateway.intent.ts";
import { decideAgentCommunicationWithRuntime, validateDecision } from "./agentCommunicationGateway.decision.ts";
import { recordNonActionableQuestionObservation, queueAgentMessage, classifyAgentCommunicationFailure, queueAgentFailureFallback } from "./agentCommunicationGateway.delivery.ts";

/**
 * All normal user-visible notification intents stop here before outbox write.
 * The configured project Agent decides whether humans need a message and owns
 * the final wording. The deterministic fallback is reserved for runtime
 * outages or schema-invalid model output after compatibility parsing.
 */
export async function runAgentCommunicationGatewayOnce(
  db: RunnerDatabase,
  options: { decide?: AgentCommunicationDecider; limit?: number; now?: Date } = {}
): Promise<AgentCommunicationGatewayResult> {
  const now = options.now ?? new Date();
  const pending = listPiNotificationIntents(db, { state: "agent_pending" })
    .slice(0, boundedLimit(options.limit));
  const groups = communicationGroups(pending);
  const result = emptyResult(pending.length, groups.length);
  for (const intents of groups) {
    await processGroup(db, intents, options.decide ?? ((input) => decideAgentCommunicationWithRuntime(db, input)), now, result);
  }
  return result;
}

export async function processGroup(
  db: RunnerDatabase,
  intents: PiNotificationIntent[],
  decide: AgentCommunicationDecider,
  now: Date,
  result: AgentCommunicationGatewayResult
): Promise<void> {
  const active = intents.filter((intent) => notificationStillRelevant(db, intent));
  const stale = intents.filter((intent) => !active.includes(intent));
  for (const intent of stale) markSuppressed(db, intent, "action_no_longer_pending");
  result.suppressed += stale.length;
  if (active.length === 0) return;
  try {
    const presentation = notificationPresentation(db);
    const decision = validateDecision(await decide({ intents: active, now }), active, presentation);
    resolveAgentCommunicationIncident(db, fallbackIdentity(active[0]!), now);
    recordNonActionableQuestionObservation(db, active, decision);
    if (decision.decision === "suppress") {
      for (const intent of active) markSuppressed(db, intent, `agent_suppressed:${decision.rationale}`);
      markCoveredIntents(db, active, 0, now, `agent_suppressed:${decision.rationale}`);
      result.suppressed += active.length;
      return;
    }
    const queued = queueAgentMessage(db, active, applyNotificationSpeaker(decision.message, presentation));
    if (!queued.queued) {
      for (const intent of active) markSuppressed(db, intent, "duplicate_agent_communication");
      result.suppressed += active.length;
      return;
    }
    recordOriginalNotificationLinks(db, active);
    for (const intent of active) markSent(db, intent, queued.outboxID, now);
    markCoveredIntents(db, active, queued.outboxID, now, "");
    markApprovalDelivered(db, active);
    result.queued += 1;
  } catch (error) {
    result.failed += active.length;
    const failure = classifyAgentCommunicationFailure(error);
    const reason = `${failure.code}:${failure.message}`;
    for (const intent of active) markSuppressed(db, intent, reason);
    markCoveredIntents(db, active, 0, now, reason);
    try {
      if (queueAgentFailureFallback(db, active, now, failure.code)) result.fallback += 1;
    } catch {
      // Fallback delivery must never fail the scheduler that recorded the
      // original communication failure. The suppressed intent retains it.
    }
  }
}

export function recordOriginalNotificationLinks(db: RunnerDatabase, intents: PiNotificationIntent[]): void {
  for (const intent of intents) {
    const envelope = communicationEnvelope(intent);
    if (envelope.notificationID === "" || envelope.notificationType === "") continue;
    try {
      createExternalLink(db, {
        conversation_id: envelope.target.threadID || envelope.target.chatID,
        external_id: envelope.notificationID,
        external_type: envelope.notificationType,
        issue_id: intent.issue_id,
        project_id: intent.project_id,
        relationship: "notification",
        source: envelope.channel
      });
    } catch {
      // The Agent outbox link remains authoritative; this compatibility link
      // only preserves legacy producer-level replay detection.
    }
  }
}

export function notificationStillRelevant(db: RunnerDatabase, intent: PiNotificationIntent): boolean {
  const envelope = communicationEnvelope(intent);
  if (envelope.notificationType === "feishu_approval_notification") {
    return getPiApprovalRequest(db, envelope.approvalActionID)?.status === "pending";
  }
  if (envelope.notificationType === "feishu_pi_action_pending_notification") {
    const actionID = envelope.approvalActionID.replace(/^pi_action:/, "");
    return getPiAction(db, actionID)?.status === "pending";
  }
  return true;
}
