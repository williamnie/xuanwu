import { TERMINAL_ATTENTION_STATUSES } from "./contracts.model.ts";
import type { AttentionRecord, AttentionCommand, AttentionTransitionResult, AttentionTransitionAudit } from "./contracts.model.ts";
import { assertAttentionRecord, assertAudit, requiredFutureTimestamp, attentionPriority, sourceIdentity } from "./contracts.validation.ts";
import { transitionStatus } from "./contracts.projection.ts";

export function applyAttentionCommand(
  current: AttentionRecord,
  command: AttentionCommand
): AttentionTransitionResult {
  assertAttentionRecord(current);
  assertAudit(command.audit);
  if (command.expected_revision !== current.revision) {
    throw new Error(`Attention revision conflict: expected ${command.expected_revision}, found ${current.revision}`);
  }
  if (command.audit.gate.decision !== "allow") {
    throw new Error(`Attention command requires an allow gate, found ${command.audit.gate.decision}`);
  }
  if (command.action === "escalate" && command.audit.gate.authority !== "deterministic_policy") {
    throw new Error("Attention escalation requires a deterministic policy gate");
  }
  if (TERMINAL_ATTENTION_STATUSES.has(current.status)) {
    throw new Error(`Attention ${current.id} is terminal`);
  }

  const next = structuredClone(current);
  const before = current.status;
  switch (command.action) {
    case "acknowledge":
      next.status = transitionStatus(current.status, "acknowledged");
      delete next.snoozed_until;
      break;
    case "snooze": {
      const until = requiredFutureTimestamp(command.snoozed_until, command.audit.occurred_at, "snoozed_until");
      next.status = transitionStatus(current.status, "waiting");
      next.snoozed_until = until;
      break;
    }
    case "resolve":
      next.status = transitionStatus(current.status, "resolved");
      delete next.snoozed_until;
      break;
    case "dismiss":
      next.status = transitionStatus(current.status, "dismissed");
      delete next.snoozed_until;
      break;
    case "escalate":
      next.escalation.count += 1;
      next.escalation.last_escalated_at = command.audit.occurred_at;
      next.priority = attentionPriority(next.type, next.severity, next.escalation.count);
      break;
  }
  next.revision += 1;
  next.updated_at = command.audit.occurred_at;
  return transitionResult(current, next, command.action, command.audit);
}

export function transitionResult(
  before: AttentionRecord,
  after: AttentionRecord,
  operation: AttentionTransitionResult["audit_event"]["operation"],
  audit: AttentionTransitionAudit
): AttentionTransitionResult {
  return {
    attention: after,
    audit_event: {
      actor: audit.actor,
      after_status: after.status,
      before_status: before.status,
      correlation_id: audit.correlation_id,
      event_id: audit.event_id,
      gate: audit.gate,
      occurred_at: audit.occurred_at,
      operation,
      reason: audit.reason,
      source_refs: after.source_refs.map(sourceIdentity)
    }
  };
}
