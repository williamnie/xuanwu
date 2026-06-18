import type { RunnerDatabase } from "../db/database.ts";
import { createPiActionEvent, type PiAction } from "../db/repositories/pi.ts";
import type { AppEvent, EventBus } from "../events/bus.ts";
import type { PiActionDecision } from "./actionGate.ts";

type AuditInput = {
  actor?: string;
  decision?: string;
  error?: string;
  payload?: unknown;
  reason?: string;
  result?: unknown;
};

export function recordPiActionAuditEvent(
  db: RunnerDatabase,
  action: PiAction,
  eventType: string,
  input: AuditInput = {}
): void {
  createPiActionEvent(db, {
    action_id: action.id,
    actor: cleanString(input.actor),
    conversation_id: action.conversation_id,
    decision: cleanString(input.decision),
    delegation_id: action.delegation_id,
    error: cleanString(input.error),
    event_type: eventType,
    heartbeat_id: action.heartbeat_id,
    issue_id: action.issue_id,
    payload_json: JSON.stringify(input.payload ?? {}),
    project_id: action.project_id,
    reason: cleanString(input.reason),
    result_json: JSON.stringify(input.result ?? {})
  });
}

export function publishGateEvent(bus: EventBus | undefined, decision: PiActionDecision, action: PiAction): void {
  if (decision === "deny") publishPiActionEvent(bus, "pi.action_denied", action);
  if (decision === "snooze") publishPiActionEvent(bus, "pi.action_snoozed", action);
}

export function publishPiActionEvent(bus: EventBus | undefined, type: string, action: PiAction): void {
  bus?.publish(piActionEvent(type, action));
}

function piActionEvent(type: string, action: PiAction): AppEvent {
  return {
    type,
    conversationId: action.conversation_id,
    issueId: action.issue_id || undefined,
    projectId: action.project_id,
    payload: JSON.stringify({
      action_id: action.id,
      action_type: action.action_type,
      decision: action.gate_decision,
      requires_confirmation: action.requires_confirmation === 1,
      risk_level: action.risk_level,
      status: action.status
    }),
    created_at: action.updated_at
  };
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
